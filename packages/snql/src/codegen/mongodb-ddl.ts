import { SnqlError } from "../diagnostics";
import {
	type AddColumnPlan,
	type AddEnumMemberPlan,
	type AddIndexPlan,
	type CreateEnumPlan,
	type CreateTableField,
	type CreateTablePlan,
	type DropColumnPlan,
	type DropEnumPlan,
	type DropIndexPlan,
	type DropRefPlan,
	type DropTablePlan,
	isDdlDefaultFn,
	isSqlJsonLiteral
} from "../ir/plan";
import type { SnqlType, StoredAs } from "../schema/model";
import type {
	MongoDDLAddColumnQuery,
	MongoDDLAddEnumMemberQuery,
	MongoDDLAddIndexQuery,
	MongoDDLCreateCollectionQuery,
	MongoDDLCreateEnumQuery,
	MongoDDLDropCollectionQuery,
	MongoDDLDropColumnQuery,
	MongoDDLDropEnumQuery,
	MongoDDLDropIndexQuery,
	MongoDDLDropRefQuery,
	MongoDefaultSpec,
	MongoIndexSpec,
	MongoRefSpec
} from "./mapper";

/**
 * DDL : MongoDB n'a pas de schéma, les instructions deviennent des
 * opérations que l'adaptateur émule (validateur, index, métadonnées).
 */

/**
 * Mapping SnqlType canonique → BSON type pour `$jsonSchema` validator (ADR-029
 * D1). Aligné MONGO_CAST_TYPE + choix explicit `date → date` (BSON Date =
 * instant UTC), `array → array`. `enum` = string (les enums PG-only, Mongo
 * n'a pas d'enum type — passe par validator `enum: [...]` v-next). `unknown`
 * = null (pas de contrainte type).
 */
const MONGO_BSON_TYPE: Readonly<Record<SnqlType, string | null>> = {
	string: "string",
	int: "int",
	bigint: "long",
	float: "double",
	decimal: "decimal",
	bool: "bool",
	date: "date",
	json: "object",
	array: "array",
	uuid: "binData",
	enum: "string",
	unknown: null
};

/**
 * Motif du validateur d'un type rangé en texte sous le profil `prisma`
 * (ADR-036 D6) : l'uuid canonique en minuscules, comme l'écrit `uuid()`, et un
 * décimal en notation décimale. L'introspection y relit le type SNQL.
 */
export const MONGO_TEXT_PATTERN: Readonly<Partial<Record<SnqlType, string>>> = {
	uuid: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
	decimal: "^-?[0-9]+(\\.[0-9]+)?([eE][-+]?[0-9]+)?$"
};

/** Type BSON du validateur, et motif d'un type rangé en texte, selon `storedAs`. */
export function mongoColumnType(
	type: SnqlType,
	storedAs: StoredAs | undefined
): { readonly bsonType: string | null; readonly pattern?: string } {
	if (storedAs === "objectId") return { bsonType: "objectId" };
	if (storedAs === "string") {
		const pattern = MONGO_TEXT_PATTERN[type];
		return pattern !== undefined
			? { bsonType: "string", pattern }
			: { bsonType: "string" };
	}
	return { bsonType: MONGO_BSON_TYPE[type] };
}

/**
 * Rend une property $jsonSchema pour un field du plan. Type builtin →
 * `{bsonType}`, enum (ADR-030 Enum/2) → `{bsonType: "string", enum: [...]}`
 * — Mongo enforce nativement le enum dans le validator.
 *
 * Un field **nullable** émet `bsonType: [<type>, "null"]` (sinon le validator
 * `$jsonSchema` refuse la valeur `null` — null n'est pas un `string` en BSON,
 * ce qui casse `add {col: null}` ET le `on delete set null` d'une FK, ADR-031).
 * Un enum nullable ajoute `null` à la liste `enum` (le keyword enum exige la
 * valeur dans la liste, indépendamment de bsonType).
 */
function buildMongoFieldProperty(f: CreateTableField): Record<string, unknown> {
	const { bsonType: bson, pattern } = mongoColumnType(f.type, f.storedAs);
	const property: Record<string, unknown> = {};
	if (bson !== null) {
		property.bsonType = f.nullable ? [bson, "null"] : bson;
	}
	if (pattern !== undefined) property.pattern = pattern;
	if (f.type === "enum" && f.enumMembers !== undefined) {
		property.enum = f.nullable ? [...f.enumMembers, null] : f.enumMembers;
	}
	return property;
}

/**
 * Rend un `create table` en `MongoDDLQuery` (ADR-029 D13 + validator BSON).
 * L'adapter runtime :
 *  1. `db.createCollection(collection, { validator: {$jsonSchema} })` (D3 catch
 *     NamespaceExists code 48 si `ifNotExists=true`).
 *  2. Pour chaque `indexes[]` : `db.<collection>.createIndex(keys, options)`
 *     (compound PK + uniques field-level).
 *  3. `primaryKeyAlias` : alias `id` ↔ `_id` géré au read/write layer.
 *
 * Refus D13 (invariance sémantique, PAS gap engine) : PK single-field sur
 * field ≠ `id` refusé — Mongo n'a pas de PK secondaire vraie. Hint pointe vers
 * `add unique index` (DDL/3).
 */
export function renderMongoCreateTable(
	plan: CreateTablePlan
): MongoDDLCreateCollectionQuery {
	const pk = plan.primaryKey;
	// D13 : détecte le cas alias `_id` (single-field, nom == "id") — le field
	// n'entre PAS dans le $jsonSchema car _id est géré natif par Mongo.
	const primaryKeyAlias =
		pk !== undefined && pk.length === 1 && pk[0] === "id" ? "id" : undefined;

	// D13 refus : PK single sur field ≠ "id" — refus sémantique admis.
	if (pk !== undefined && pk.length === 1 && primaryKeyAlias === undefined) {
		throw new SnqlError(
			`primary key sur '${pk[0]}' non supporté sur Mongo — Mongo utilise '_id' comme PK unique. Pour un unique secondaire, utilise 'add unique index (${pk[0]}) into ${plan.target}'.`,
			"codegen_mongo_primary_key_not_id"
		);
	}

	// Validator $jsonSchema : properties par field + required pour les non-nullables.
	// Skip le field aliasé _id (Mongo le gère natif comme ObjectId/UUID).
	const properties: Record<string, unknown> = {};
	const required: string[] = [];
	for (const f of plan.fields) {
		if (primaryKeyAlias !== undefined && f.name === primaryKeyAlias) continue;
		properties[f.name] = buildMongoFieldProperty(f);
		if (!f.nullable) required.push(f.name);
	}
	const jsonSchema: Record<string, unknown> = {
		bsonType: "object",
		properties
	};
	if (required.length > 0) jsonSchema.required = required;
	const validator: Record<string, unknown> = { $jsonSchema: jsonSchema };

	// Indexes : PK compound + uniques field-level (D13).
	const indexes: MongoIndexSpec[] = [];
	if (pk !== undefined && pk.length > 1) {
		const keys: Record<string, 1> = {};
		for (const k of pk) keys[k] = 1;
		indexes.push({
			keys,
			options: {
				unique: true,
				name: plan.primaryKeyName ?? `pk_${pk.join("_")}`
			}
		});
	}
	for (const f of plan.fields) {
		if (!f.unique) continue;
		// Aliasé _id : Mongo gère l'unicité natif, pas d'index à créer.
		if (primaryKeyAlias !== undefined && f.name === primaryKeyAlias) continue;
		indexes.push({
			keys: { [f.name]: 1 },
			options: { unique: true, name: f.uniqueName ?? `unique_${f.name}` }
		});
	}

	// FK déclarées (ADR-031 FK/1a) → snapshot _snql_refs (déclaration seulement,
	// enforcement = FK/1b).
	const refs: MongoRefSpec[] = [];
	for (const f of plan.fields) {
		if (f.ref !== undefined) refs.push(mongoRefSpec(f.ref, plan.target));
	}

	// Le défaut de l'alias vaut pour `_id` : `default uuid()` donne la clé.
	const defaults: MongoDefaultSpec[] = [];
	for (const f of plan.fields) {
		if (f.defaultValue === undefined) continue;
		const column = f.name === primaryKeyAlias ? "_id" : f.name;
		defaults.push({ column, ...mongoDefaultSpec(f.defaultValue) });
	}
	const keyField = plan.fields.find((f) => f.name === primaryKeyAlias);
	const primaryKeyType = keyField?.type;
	const primaryKeyStoredAs = keyField?.storedAs;

	const ddl: MongoDDLCreateCollectionQuery = {
		engine: "mongodb",
		kind: "mongo-ddl",
		operation: "create-collection",
		collection: plan.target,
		ifNotExists: plan.ifNotExists,
		validator,
		...(indexes.length > 0 ? { indexes } : {}),
		...(primaryKeyAlias !== undefined ? { primaryKeyAlias } : {}),
		...(primaryKeyType !== undefined ? { primaryKeyType } : {}),
		...(primaryKeyStoredAs !== undefined ? { primaryKeyStoredAs } : {}),
		...(refs.length > 0 ? { refs } : {}),
		...(defaults.length > 0 ? { defaults } : {})
	};
	return ddl;
}

/**
 * Défaut DDL → valeur littérale native (JSON déballé) ou fonction évaluée par
 * l'adapter (ADR-036 E/1d).
 */
export function mongoDefaultSpec(
	value: import("../ir/plan").DdlDefault
): Omit<MongoDefaultSpec, "column"> {
	if (isDdlDefaultFn(value)) return { fn: value.fn };
	return { value: isSqlJsonLiteral(value) ? value.parsed : value };
}

/** Traduit un `FieldRefPlan` en `MongoRefSpec` (metadata _snql_refs). */
export function mongoRefSpec(
	ref: import("../ir/plan").FieldRefPlan,
	fromCollection: string
): MongoRefSpec {
	return {
		name: ref.name,
		fromCollection,
		fromColumn: ref.fromColumn,
		toCollection: ref.targetCollection,
		toColumn: ref.targetColumn,
		onDelete: ref.onDelete,
		onUpdate: ref.onUpdate
	};
}

/**
 * Rend un `add column` en `MongoDDLAddColumnQuery` (ADR-029 DDL/2). L'adapter
 * runtime consomme le shape et exécute :
 *  1. D2 preflight : si `preflightNotNull=true` → `countDocuments({[col]:
 *     {$exists:false}})` avant `collMod`. Si > 0, refus runtime typé.
 *  2. `collMod` avec validator étendu (ajoute properties.<col> + éventuel
 *     required). L'adapter merge avec le validator existant.
 *  3. D10 backfill : si `backfill=true` → `updateMany({[col]: {$exists:false}},
 *     {$set: {[col]: defaultValue}})` batched. Jamais refus (transformer NON
 *     en OUI, PA/1-8).
 *  4. Si `index` présent, `createIndex(keys, options)` (add column ... unique).
 *
 * Refus D13 admis (adjacent, à surface dans les tests indexes) : un
 * `add column ... unique` sur un field qui deviendrait un PK secondaire n'est
 * PAS refusé côté add-column — DDL/2 accepte l'unique index secondaire (D12
 * arrivera avec l'enforcement).
 */
/**
 * Rend `add [unique] index (fields) into T` en `MongoDDLAddIndexQuery`
 * (ADR-029 DDL/3). L'adapter runtime execute `db.<collection>.createIndex(keys,
 * options)` — natif Mongo, idempotent. D3 : catch `IndexOptionsConflict` (85)
 * ou `IndexKeySpecsConflict` (86) si `ifNotExists=true`.
 */
export function renderMongoAddIndex(plan: AddIndexPlan): MongoDDLAddIndexQuery {
	const keys: Record<string, 1> = {};
	for (const f of plan.fields) keys[f] = 1;
	const unique = plan.kind === "add-unique-index";
	const spec: MongoIndexSpec = {
		keys,
		options: {
			...(unique ? { unique: true } : {}),
			name: plan.name
		}
	};
	return {
		engine: "mongodb",
		kind: "mongo-ddl",
		operation: "add-index",
		collection: plan.target,
		ifNotExists: plan.ifNotExists,
		index: spec
	};
}

/**
 * Rend `drop index NAME from T` en `MongoDDLDropIndexQuery`. L'adapter
 * runtime execute `db.<collection>.dropIndex(name)` — natif. D3 : catch
 * `IndexNotFound` (code 27) si `ifExists=true`.
 */
export function renderMongoDropIndex(
	plan: DropIndexPlan
): MongoDDLDropIndexQuery {
	return {
		engine: "mongodb",
		kind: "mongo-ddl",
		operation: "drop-index",
		collection: plan.target,
		ifExists: plan.ifExists,
		name: plan.name
	};
}

/**
 * Rend `drop ref NAME from T` en `MongoDDLDropRefQuery` (ADR-031 FK/3).
 * Compensation runtime : `_snql_refs.deleteOne({_id: name})` (`_id` = nom de
 * contrainte, clé d'upsert FK/1a). L'enforcement write-precheck/cascade
 * s'arrête de lui-même — `#loadRefs` recharge à chaque write.
 */
export function renderMongoDropRef(plan: DropRefPlan): MongoDDLDropRefQuery {
	return {
		engine: "mongodb",
		kind: "mongo-ddl",
		operation: "drop-ref",
		collection: plan.target,
		name: plan.name,
		ifExists: plan.ifExists
	};
}

/**
 * Rend `drop table T` en `MongoDDLDropCollectionQuery` (ADR-029 DDL/4).
 * L'adapter runtime execute `db.<collection>.drop()` natif Mongo (retour bool
 * true/false selon existence). D3 `ifExists=true` : catch `NamespaceNotFound`
 * (code 26) traité comme succès silencieux.
 */
export function renderMongoDropCollection(
	plan: DropTablePlan
): MongoDDLDropCollectionQuery {
	return {
		engine: "mongodb",
		kind: "mongo-ddl",
		operation: "drop-collection",
		collection: plan.target,
		ifExists: plan.ifExists
	};
}

/**
 * Rend `drop column COL from T` en `MongoDDLDropColumnQuery` (ADR-029 DDL/4).
 * Compensation runtime : (1) collMod validator sans property + retire de
 * required si présent, (2) updateMany `$unset` batched pattern miroir D10
 * backfill pour purger la valeur dans les docs existants. `ifExists=true`
 * skip si la property n'est pas dans le validator (D3 name-only).
 */
export function renderMongoDropColumn(
	plan: DropColumnPlan
): MongoDDLDropColumnQuery {
	return {
		engine: "mongodb",
		kind: "mongo-ddl",
		operation: "drop-column",
		collection: plan.target,
		column: plan.column,
		ifExists: plan.ifExists
	};
}

/**
 * Rend `create enum NAME { "m1", "m2" }` en `MongoDDLCreateEnumQuery`
 * (ADR-030 Enum/1). Compensation runtime : l'adapter `insertOne` dans
 * collection `_snql_enums` avec `{_id: name, members}`. Idempotent par `_id`
 * — l'adapter catch DuplicateKey 11000 si `ifNotExists=true` et silence.
 * Le validator `enum: [...]` sera propagé aux $jsonSchema des tables
 * utilisatrices via Enum/2.
 */
export function renderMongoCreateEnum(
	plan: CreateEnumPlan
): MongoDDLCreateEnumQuery {
	return {
		engine: "mongodb",
		kind: "mongo-ddl",
		operation: "create-enum",
		name: plan.name,
		members: plan.members,
		ifNotExists: plan.ifNotExists
	};
}

/**
 * Rend `add enum member NAME "m"` en `MongoDDLAddEnumMemberQuery` (ADR-030
 * Enum/3). Compensation runtime : l'adapter updateOne `_snql_enums`
 * `{$addToSet: {members: value}}` (idempotent — dedup naturel Set), puis
 * `collMod` batché sur chaque collection utilisatrice pour patcher
 * `$jsonSchema.properties.<col>.enum` avec le nouveau tableau.
 */
export function renderMongoAddEnumMember(
	plan: AddEnumMemberPlan
): MongoDDLAddEnumMemberQuery {
	return {
		engine: "mongodb",
		kind: "mongo-ddl",
		operation: "add-enum-member",
		name: plan.name,
		member: plan.member,
		ifNotExists: plan.ifNotExists
	};
}

/**
 * Rend `drop enum NAME [if exists] [cascade]` en `MongoDDLDropEnumQuery`
 * (ADR-030 Enum/3 D8). Compensation runtime : l'adapter deleteOne
 * `_snql_enums`, puis rollback des validators via `collMod` batché sur les
 * collections utilisatrices. RESTRICT (cascade=false) : refus runtime si
 * ≥1 collection utilise l'enum ; CASCADE : applique le rollback sans check.
 */
export function renderMongoDropEnum(plan: DropEnumPlan): MongoDDLDropEnumQuery {
	return {
		engine: "mongodb",
		kind: "mongo-ddl",
		operation: "drop-enum",
		name: plan.name,
		ifExists: plan.ifExists,
		cascade: plan.cascade
	};
}

export function renderMongoAddColumn(
	plan: AddColumnPlan
): MongoDDLAddColumnQuery {
	const f = plan.column;
	const { bsonType: bson, pattern } = mongoColumnType(f.type, f.storedAs);
	const required = !f.nullable;
	const backfill = f.defaultValue !== undefined;
	// D2 preflight = NOT NULL sans default. Si NOT NULL + default, le backfill
	// D10 assure l'invariance (les rows existantes reçoivent la valeur).
	const preflightNotNull = required && !backfill;
	// SqlJsonLiteral → unwrap `.parsed` : l'adapter $set attend un objet natif,
	// pas le wrapper `{kind, raw, parsed}`.
	const defaultSpec =
		f.defaultValue !== undefined ? mongoDefaultSpec(f.defaultValue) : undefined;
	const columnSpec: MongoDDLAddColumnQuery["column"] = {
		name: f.name,
		bsonType: bson,
		...(pattern !== undefined ? { pattern } : {}),
		required,
		...(defaultSpec !== undefined && defaultSpec.fn === undefined
			? { defaultValue: defaultSpec.value }
			: {}),
		...(defaultSpec?.fn !== undefined ? { defaultFn: defaultSpec.fn } : {}),
		...(f.type === "enum" && f.enumMembers !== undefined
			? { enum: f.enumMembers }
			: {}),
		...(f.ref !== undefined ? { ref: mongoRefSpec(f.ref, plan.target) } : {})
	};
	const index: MongoIndexSpec | undefined = f.unique
		? {
				keys: { [f.name]: 1 },
				options: { unique: true, name: f.uniqueName ?? `unique_${f.name}` }
			}
		: undefined;
	return {
		engine: "mongodb",
		kind: "mongo-ddl",
		operation: "add-column",
		collection: plan.target,
		ifNotExists: plan.ifNotExists,
		column: columnSpec,
		backfill,
		preflightNotNull,
		...(index !== undefined ? { index } : {})
	};
}
