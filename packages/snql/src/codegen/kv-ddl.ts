/**
 * Codegen KV pour DDL Tier-2 (ADR-029). Aucune API `CREATE TABLE` — KV est
 * schema-less. On stocke le shape en metadata sous `namespace:_schema:{table}`
 * (hash HSET) et on transporte le PK comme metadata (jamais refus, thèse
 * Hard Version + PA/1-8 : gap engine → COMPENSATION, pas refus). D3 idempotence
 * via existence-check du hash côté adapter runtime.
 *
 * Pas de kvMapper complet (KV n'a pas de map() lecture — les reads passent par
 * scan + compensate()). Helper standalone consommé par les tests + l'adapter
 * runtime `packages/backend` quand DDL/1.8/1.9 branchent le pipeline.
 */

import { SnqlError } from "../diagnostics";
import type {
	AddColumnPlan,
	AddIndexPlan,
	CreateTablePlan,
	DDLPlan,
	DropColumnPlan,
	DropIndexPlan,
	DropTablePlan
} from "../ir/plan";
import type { SnqlType } from "../schema/model";
import type {
	KvDDLAddColumnQuery,
	KvDDLAddIndexQuery,
	KvDDLCreateTableQuery,
	KvDDLDropColumnQuery,
	KvDDLDropIndexQuery,
	KvDDLDropTableQuery,
	KvDDLQuery,
	KvFieldDescriptor
} from "./mapper";

/**
 * Mapping SnqlType canonique → nom sérialisé stocké dans le hash `_schema`
 * (D1). KV n'a pas de type natif — c'est du texte descriptif utilisé au
 * read/write layer pour parser/valider. Aligné SnqlType canonique 1:1
 * (round-trip identity — pas de coercion vs BSON/PG).
 */
const KV_META_TYPE: Readonly<Record<SnqlType, string>> = {
	string: "string",
	int: "int",
	bigint: "bigint",
	float: "float",
	decimal: "decimal",
	bool: "bool",
	date: "date",
	json: "json",
	array: "array",
	uuid: "uuid",
	enum: "enum",
	unknown: "unknown"
};

/**
 * Rend un `create table` en `KvDDLQuery`. Le shape encode le schema en
 * descriptors sérialisables (l'adapter runtime les stocke via HSET). D13 KV :
 * `primaryKey` est propagé tel quel (single ou compound) — l'adapter en
 * dérive une clé unique `namespace:{table}:pk:<v1>:<v2>` au write.
 */
export function mapKvDDL(plan: DDLPlan): KvDDLQuery {
	if (plan.kind === "create-table") return renderKvCreateTable(plan);
	if (plan.kind === "add-column") return renderKvAddColumn(plan);
	if (plan.kind === "add-index" || plan.kind === "add-unique-index") {
		return renderKvAddIndex(plan);
	}
	if (plan.kind === "drop-index") return renderKvDropIndex(plan);
	if (plan.kind === "drop-table") return renderKvDropTable(plan);
	if (plan.kind === "drop-column") return renderKvDropColumn(plan);
	throw new SnqlError(
		`DDL kind '${(plan as { kind: string }).kind}' non supporté par le codegen KV V1`,
		"codegen_ddl_unsupported"
	);
}

/**
 * Rend `drop table T` en KvDDLDropTableQuery (ADR-029 DDL/4). Compensation
 * runtime : adapter SCAN namespace:{collection}:* + DEL par batch + DEL
 * namespace:_schema:{collection} + DEL namespace:_unique:* (middleware
 * indexes). Idempotence D3 name-only via ifExists (adapter check HEXISTS
 * _schema:{coll}).
 */
function renderKvDropTable(plan: DropTablePlan): KvDDLDropTableQuery {
	return {
		engine: "kv",
		kind: "kv-ddl",
		operation: "drop-table",
		collection: plan.target,
		ifExists: plan.ifExists
	};
}

/**
 * Rend `drop column COL from T` en KvDDLDropColumnQuery. Compensation
 * runtime : SCAN + HDEL par row batched (miroir D10 backfill) + HDEL
 * namespace:_schema:{collection} col metadata. Idempotence D3 name-only.
 */
function renderKvDropColumn(plan: DropColumnPlan): KvDDLDropColumnQuery {
	return {
		engine: "kv",
		kind: "kv-ddl",
		operation: "drop-column",
		collection: plan.target,
		column: plan.column,
		ifExists: plan.ifExists
	};
}

/**
 * Rend add [unique] index (ADR-029 DDL/3 D12). Non-unique = no-op au planner
 * (queries retombent en scan compensé — pas d'index KV natif). Unique =
 * `uniqueEnforcement: "middleware-setnx"` — l'adapter enregistre le middleware
 * pré-write SETNX qui rejette au write si `SETNX namespace:_unique:<f>:<v>`
 * échoue.
 */
function renderKvAddIndex(plan: AddIndexPlan): KvDDLAddIndexQuery {
	const unique = plan.kind === "add-unique-index";
	return {
		engine: "kv",
		kind: "kv-ddl",
		operation: "add-index",
		collection: plan.target,
		ifNotExists: plan.ifNotExists,
		name: plan.name,
		fields: plan.fields,
		unique,
		uniqueEnforcement: unique ? "middleware-setnx" : "none"
	};
}

function renderKvDropIndex(plan: DropIndexPlan): KvDDLDropIndexQuery {
	return {
		engine: "kv",
		kind: "kv-ddl",
		operation: "drop-index",
		collection: plan.target,
		ifExists: plan.ifExists,
		name: plan.name
	};
}

/**
 * Rend un `add column` en KvDDLAddColumnQuery. D2 preflight + D10 backfill
 * sont computés ici (booleans) — l'adapter runtime KV s'en sert pour décider
 * du SCAN preflight et du HSET batched. Toujours compensation, jamais refus.
 */
function renderKvAddColumn(plan: AddColumnPlan): KvDDLAddColumnQuery {
	const f = plan.column;
	const descriptor: KvFieldDescriptor = {
		name: f.name,
		type: KV_META_TYPE[f.type],
		nullable: f.nullable,
		unique: f.unique,
		...(f.defaultValue !== undefined
			? { defaultValue: serializeDefault(f.defaultValue) }
			: {})
	};
	const backfill = f.defaultValue !== undefined;
	// D2 preflight = NOT NULL sans default. Si NOT NULL + default, le backfill
	// D10 pose la valeur sur toutes les rows → invariance garantie.
	const preflightNotNull = !f.nullable && !backfill;
	return {
		engine: "kv",
		kind: "kv-ddl",
		operation: "add-column",
		collection: plan.target,
		ifNotExists: plan.ifNotExists,
		column: descriptor,
		backfill,
		preflightNotNull
	};
}

function renderKvCreateTable(plan: CreateTablePlan): KvDDLCreateTableQuery {
	const fields: KvFieldDescriptor[] = plan.fields.map((f) => {
		const base: KvFieldDescriptor = {
			name: f.name,
			type: KV_META_TYPE[f.type],
			nullable: f.nullable,
			unique: f.unique
		};
		return f.defaultValue !== undefined
			? { ...base, defaultValue: serializeDefault(f.defaultValue) }
			: base;
	});
	const uniqueFields = plan.fields.filter((f) => f.unique).map((f) => f.name);
	const q: KvDDLCreateTableQuery = {
		engine: "kv",
		kind: "kv-ddl",
		operation: "create-table",
		collection: plan.target,
		ifNotExists: plan.ifNotExists,
		fields,
		...(plan.primaryKey !== undefined ? { primaryKey: plan.primaryKey } : {}),
		...(uniqueFields.length > 0 ? { uniqueFields } : {})
	};
	return q;
}

/**
 * KV stocke les descriptors en texte (Redis HSET string values). Un `bigint`
 * / `SqlDecimal` doit être sérialisé lossless — pas de `String(BigInt)`
 * silencieux qui casserait le round-trip. L'adapter parse à la lecture selon
 * le type déclaré.
 */
function serializeDefault(value: unknown): unknown {
	if (typeof value === "bigint") return value.toString();
	if (
		typeof value === "object" &&
		value !== null &&
		(value as { kind?: unknown }).kind === "decimal"
	) {
		return (value as { raw: string }).raw;
	}
	return value;
}
