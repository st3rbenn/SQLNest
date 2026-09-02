import { SnqlError } from "../diagnostics";
import type {
	AddColumnPlan,
	AddEnumMemberPlan,
	AddIndexPlan,
	CastTarget,
	CreateEnumPlan,
	CreateTablePlan,
	DDLPlan,
	DdlDefault,
	DropColumnPlan,
	DropEnumPlan,
	DropIndexPlan,
	DropRefPlan,
	DropTablePlan,
	IntrospectPlan,
	LetPlan,
	LogicalPlan,
	MutationPlan,
	PlanExpr,
	PlanProjectField,
	PlanRowValue,
	RawPlan,
	TransactionPlan
} from "../ir/plan";
import { isSqlDecimal, isSqlJsonLiteral } from "../ir/plan";
import type { SnqlType } from "../schema/model";
import type {
	Mapper,
	NativeQuery,
	SerializedSpan,
	SqlQuery,
	SqlTransaction
} from "./mapper";
import {
	buildSqlTransactionSteps,
	createSqlRenderer,
	type ParamList,
	type SqlDialect,
	type TypedParamKind
} from "./sql-core";

/**
 * Mapper Postgres — pur, génère SQL + paramètres bindés ($1, $2…).
 *
 * La mécanique SELECT (absorb/materialize, renderExpr, joins embed/left/count)
 * vit dans `sql-core` (partagée avec MSSQL — chantier M/3) ; ce module porte le
 * DIALECTE PG + tout ce qui reste PG-only : mutations (RETURNING/ON CONFLICT),
 * transactions, introspection tier-1, DDL Tier-2, let/CTE.
 *
 * Sûreté : valeurs TOUJOURS paramétrées ; identifiants validés puis quotés.
 */

/**
 * Mapping des 7 targets canoniques SNQL vers les types Postgres. Choix figés :
 *  - `int → bigint` (INT64, aligné SqlValue.bigint + PK bigint des schémas)
 *  - `float → double precision` (IEEE 754 64-bit, aligné Mongo double)
 *  - `timestamp → timestamptz` (instant UTC, roundtrip Mongo Date lossless)
 *  - `json → jsonb` (indexable, canonicalisé, comparable)
 */
export const PG_CAST_TYPE: Readonly<Record<CastTarget, string>> = {
	int: "bigint",
	float: "double precision",
	text: "text",
	bool: "boolean",
	date: "date",
	timestamp: "timestamptz",
	json: "jsonb"
};

/** Types PG des annotations de paramètres (littéraux JSON, arith décimale). */
const PG_TYPED_PARAM: Readonly<Record<TypedParamKind, string>> = {
	text: "text",
	bool: "boolean",
	bigint: "bigint",
	float: "double precision",
	numeric: "numeric",
	json: "jsonb"
};

const PG_DIALECT: SqlDialect = {
	engine: "postgres",
	wrapIdent: (name) => `"${name}"`,
	paramRef: (index) => `$${index}`,
	falseLiteral: () => "FALSE",
	typedParam: (ref, kind) => `${ref}::${PG_TYPED_PARAM[kind]}`,
	castType: (target) => PG_CAST_TYPE[target],
	embedAgg: ({ innerRef, fromClause, correlation }) =>
		`(SELECT COALESCE(json_agg(${innerRef}.*), '[]'::json) FROM ${fromClause} WHERE ${correlation})`,
	rowObject: (aliasSql) => `row_to_json(${aliasSql})`,
	jsonObject: (parts) => `jsonb_build_object(${parts.join(", ")})`,
	jsonArray: (parts) => `jsonb_build_array(${parts.join(", ")})`,
	distinctOnStrategy: "native",
	limitFragments: ({ limitRef, offsetRef }) => {
		const bits: string[] = [];
		if (limitRef !== "") bits.push(`LIMIT ${limitRef}`);
		if (offsetRef !== undefined) bits.push(`OFFSET ${offsetRef}`);
		return { afterOrder: bits.join(" ") };
	},
	upsertNewRef: (columnSql) => `EXCLUDED.${columnSql}`,
	recursiveCtePrefix: "WITH RECURSIVE"
};

const PG = createSqlRenderer(PG_DIALECT);
const {
	newParams,
	quoteIdent,
	renderPlan,
	renderExpr,
	renderProjection,
	renderSortKey,
	renderJoinPath
} = PG;

export const postgresMapper: Mapper = {
	engine: "postgres",
	map(plan: LogicalPlan): NativeQuery {
		const params = newParams();
		const text = renderPlan(plan, params);
		return {
			engine: "postgres",
			kind: "sql",
			text,
			params: params.all(),
			paramSpans: params.allSpans()
		};
	},
	mapMutation(plan: MutationPlan): NativeQuery {
		const params = newParams();
		const text = renderMutation(plan, params);
		// Phase 3c : les rowSpans des INSERT sont exposés sur la SqlQuery pour que
		// le pgError puisse cibler une row source précise sur unique/FK violation.
		const rowSpans =
			plan.op === "insert" && plan.rowSpans !== undefined
				? plan.rowSpans.map((span) =>
						span !== undefined
							? ([span.start.offset, span.end.offset - span.start.offset] as SerializedSpan)
							: undefined
					)
				: undefined;
		return {
			engine: "postgres",
			kind: "sql",
			text,
			params: params.all(),
			paramSpans: params.allSpans(),
			...(rowSpans !== undefined ? { rowSpans } : {})
		};
	},
	/**
	 * rend un TransactionPlan en SqlTransaction pré-flat avec
	 * savepoints. Chaque statement porte sa propre ParamList (les $1..$N sont
	 * scopés au statement — l'engine bind par statement).
	 */
	mapTransaction(plan: TransactionPlan): SqlTransaction {
		const steps = buildSqlTransactionSteps(plan.body, {
			renderRead: renderReadAsSqlQuery,
			renderWrite: renderWriteAsSqlQuery
		});
		return plan.isolation !== undefined
			? { engine: "postgres", kind: "transaction", isolation: plan.isolation, steps }
			: { engine: "postgres", kind: "transaction", steps };
	},
	/**
	 * rend un IntrospectPlan en SqlQuery via `information_schema`.
	 * Le namespace (PG schema, ex: "public") vient du context runtime — fallback
	 * "public" si absent (default PG standard). Query text stable, params bindés.
	 */
	mapIntrospect(
		plan: IntrospectPlan,
		ctx?: import("./mapper").MapperContext
	): NativeQuery {
		// `list schema_events` — table système SQLNest. Le codegen émet un
		// `SqlnestIntrospectQuery` indépendant de l'engine cible : l'exécution
		// est routée par le backend vers `getCanvasChecksumHistory` (jamais le
		// tunnel proxy vers la DB user).
		if (plan.kind === "list-schema-events") {
			return plan.postOps !== undefined && plan.postOps.length > 0
				? {
						engine: "postgres",
						kind: "sqlnest-introspect",
						target: "schema-events",
						postOps: plan.postOps
					}
				: {
						engine: "postgres",
						kind: "sqlnest-introspect",
						target: "schema-events"
					};
		}
		// `list databases` = Mongo-first. PG n'a pas de listing des DBs du
		// cluster utilisable en pratique (pg_database exige souvent superuser).
		// Le vrai refus vit au planner (matrice INTROSPECT_SUPPORT) ; ce
		// garde-fou codegen évite un fallback silencieux si le kind descend
		// jusqu'ici.
		if (plan.kind === "list-databases") {
			throw new SnqlError(
				"'list databases' non supporté sur Postgres — utilise 'list schemas' pour les namespaces intra-DB.",
				"codegen_introspect_unsupported"
			);
		}
		const namespace = ctx?.namespace ?? "public";
		const params = newParams();
		let baseText: string;
		if (plan.kind === "list-tables") {
			const nsRef = params.add(namespace);
			baseText = `SELECT table_name AS name FROM information_schema.tables WHERE table_schema = ${nsRef} AND table_type = 'BASE TABLE' ORDER BY table_name`;
		} else if (plan.kind === "describe-table") {
			if (plan.target === undefined) {
				throw new SnqlError(
					"'describe' sans table cible (bug parser)",
					"codegen_introspect_missing_target"
				);
			}
			const nsRef = params.add(namespace);
			const targetRef = params.add(plan.target);
			baseText = describeTableSql(nsRef, targetRef);
		} else if (plan.kind === "list-schemas") {
			// Exclut les schemas système PG (`pg_*`, `information_schema`) — l'user
			// veut voir SES schemas, pas la plomberie du catalog.
			baseText = `SELECT schema_name AS name FROM information_schema.schemata WHERE schema_name NOT LIKE 'pg\\_%' ESCAPE '\\' AND schema_name != 'information_schema' ORDER BY schema_name`;
		} else if (plan.kind === "list-indexes") {
			const nsRef = params.add(namespace);
			const targetRef = plan.target !== undefined ? params.add(plan.target) : undefined;
			baseText = listIndexesSql(nsRef, targetRef);
		} else if (plan.kind === "list-enums") {
			// Enums nommés du schéma (sprint EN) — même source catalog que
			// l'introspection (pg_type typtype='e' + pg_enum), scopée namespace.
			const nsRef = params.add(namespace);
			baseText = `SELECT t.typname AS name, count(e.enumlabel)::int AS members_count FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = ${nsRef} GROUP BY t.typname ORDER BY t.typname`;
		} else if (plan.kind === "describe-enum") {
			if (plan.target === undefined) {
				throw new SnqlError(
					"'describe enum' sans nom cible (bug parser)",
					"codegen_introspect_missing_target"
				);
			}
			// Membres ordonnés (enumsortorder) — position 1..N propre via
			// row_number (enumsortorder est un float côté PG). Enum inexistant
			// → 0 ligne, miroir de `describe <table>` inexistante.
			const nsRef = params.add(namespace);
			const targetRef = params.add(plan.target);
			baseText = `SELECT e.enumlabel AS member, (row_number() OVER (ORDER BY e.enumsortorder))::int AS position FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = ${nsRef} AND t.typname = ${targetRef} ORDER BY e.enumsortorder`;
		} else {
			throw new SnqlError(
				`Introspect kind '${plan.kind}' non supporté par le codegen Postgres v1`,
				"codegen_introspect_unsupported"
			);
		}
		// stages pipeline (where/pick/sort/limit) → SELECT wrapper.
		const text = plan.postOps !== undefined && plan.postOps.length > 0
			? PG.wrapIntrospectPostOps(baseText, plan.postOps, params)
			: baseText;
		return {
			engine: "postgres",
			kind: "sql",
			text,
			params: params.all(),
			paramSpans: params.allSpans()
		};
	},
	/**
	 * DDL Tier-2 (ADR-029). `create table` V1. Émission :
	 *  - Sans `if not exists` : SqlQuery simple `CREATE TABLE "T" (...)`.
	 *  - Avec `if not exists` : SqlTransaction 2-steps qui pose un
	 *    `pg_advisory_xact_lock(hashtextextended('sqlnest_ddl:'||$1, 0))`
	 *    avant le `CREATE TABLE IF NOT EXISTS` (D3 sérialise le concurrent
	 *    DDL pour éviter le drift schéma silencieux). L'engine wrap
	 *    BEGIN/COMMIT — le lock est libéré au COMMIT (xact-scoped).
	 */
	mapDDL(plan: DDLPlan): NativeQuery {
		if (plan.kind === "create-table") return renderCreateTable(plan);
		if (plan.kind === "add-column") return renderAddColumn(plan);
		if (plan.kind === "add-index" || plan.kind === "add-unique-index") {
			return renderAddIndex(plan);
		}
		if (plan.kind === "drop-index") return renderDropIndex(plan);
		if (plan.kind === "drop-table") return renderDropTable(plan);
		if (plan.kind === "drop-column") return renderDropColumn(plan);
		if (plan.kind === "create-enum") return renderCreateEnum(plan);
		if (plan.kind === "add-enum-member") return renderAddEnumMember(plan);
		if (plan.kind === "drop-enum") return renderDropEnum(plan);
		if (plan.kind === "drop-ref") return renderDropRef(plan);
		throw new SnqlError(
			`DDL kind '${(plan as { kind: string }).kind}' non supporté par le codegen Postgres V1`,
			"codegen_ddl_unsupported"
		);
	},
	/**
	 * `raw "SQL"` → SqlQuery text-only, params vides. Refus
	 * explicit d'un `raw {...}` (payload Mongo sur engine PG).
	 */
	mapRaw(plan: RawPlan): NativeQuery {
		if (plan.payload.kind !== "sql") {
			throw new SnqlError(
				"'raw {...}' est un document Mongo — sur Postgres utilise 'raw \"SELECT ...\"'.",
				"codegen_raw_shape_mismatch"
			);
		}
		return {
			engine: "postgres",
			kind: "sql",
			text: plan.payload.text,
			params: [],
			paramSpans: []
		};
	},
	/**
	 * `WITH b1 AS (SQL1), b2 AS (SQL2) BODY_SQL`. Les bindings
	 * et le body partagent la MÊME ParamList — les $N s'incrémentent
	 * séquentiellement à travers tout le WITH+BODY (PG bind par position
	 * globale, pas par CTE). Un binding référence un binding précédent en
	 * tant que "table" — le codegen scan émet `FROM <cte_name>` naturellement.
	 */
	mapLet(plan: LetPlan): NativeQuery {
		const params = newParams();
		const text = PG.renderLet(plan, params, renderMutation);
		return {
			engine: "postgres",
			kind: "sql",
			text,
			params: params.all(),
			paramSpans: params.allSpans()
		};
	}
};

function renderReadAsSqlQuery(plan: LogicalPlan): SqlQuery {
	const params = newParams();
	const text = renderPlan(plan, params);
	return {
		engine: "postgres",
		kind: "sql",
		text,
		params: params.all(),
		paramSpans: params.allSpans()
	};
}

function renderWriteAsSqlQuery(plan: MutationPlan): SqlQuery {
	const params = newParams();
	const text = renderMutation(plan, params);
	return {
		engine: "postgres",
		kind: "sql",
		text,
		params: params.all(),
		paramSpans: params.allSpans()
	};
}

/**
 * SQL de `describe <table>`. Un seul SELECT — LEFT JOIN sur
 * les vues d'information_schema pour agréger PK et FK dans la même ligne
 * que la colonne. `$1` = schéma (search_path), `$2` = nom de table.
 *
 * Note sur FK sur clé composite : `constraint_column_usage` liste UNE ligne
 * par col PK cible ; sur PK composite ça duplique — v1 accepte, on garde
 * la première (STRING_AGG une prochaine version si vraiment gênant).
 */
function describeTableSql(ns: string, target: string): string {
	return (
		`SELECT ` +
			`c.column_name AS name, ` +
			// USER-DEFINED = enum/composite/domain PG. `data_type` renvoie
			// littéralement 'USER-DEFINED' — inutile pour l'utilisateur. On
			// bascule sur `udt_name` (nom du type sous-jacent, ex.
			// 'RESOURCE_STATUS') dans ce cas.
			`(CASE WHEN c.data_type = 'USER-DEFINED' THEN c.udt_name ELSE c.data_type END) AS type, ` +
			`(c.is_nullable = 'YES') AS nullable, ` +
			// column_default remonte tel quel du catalog PG, y compris les casts
			// bruts : 'draft'::"RESOURCE_STATUS", 'N/A'::character varying,
			// nextval('users_id_seq'::regclass), NULL::text… Illisible en UI.
			// On strip tous les `::TYPE` (typename quoted OU unquoted avec
			// modifiers `character varying`), les appels de fonction gardent
			// leur nom et leurs paramètres.
			`regexp_replace(c.column_default, '::(?:"[^"]+"|[a-z][a-z0-9_ ]*)', '', 'g') AS "default", ` +
			`COALESCE(pk.is_primary_key, FALSE) AS is_primary_key, ` +
			`fk.foreign_key AS foreign_key ` +
		`FROM information_schema.columns c ` +
		`LEFT JOIN (` +
			`SELECT kcu.column_name, TRUE AS is_primary_key ` +
			`FROM information_schema.table_constraints tc ` +
			`JOIN information_schema.key_column_usage kcu ` +
				`ON kcu.constraint_name = tc.constraint_name ` +
				`AND kcu.table_schema = tc.table_schema ` +
				`AND kcu.table_name = tc.table_name ` +
			`WHERE tc.constraint_type = 'PRIMARY KEY' ` +
				`AND tc.table_schema = ${ns} AND tc.table_name = ${target}` +
		`) pk ON pk.column_name = c.column_name ` +
		`LEFT JOIN (` +
			`SELECT DISTINCT ON (kcu.column_name) ` +
				`kcu.column_name, ` +
				`(ccu.table_name || '.' || ccu.column_name) AS foreign_key ` +
			`FROM information_schema.table_constraints tc ` +
			`JOIN information_schema.key_column_usage kcu ` +
				`ON kcu.constraint_name = tc.constraint_name ` +
				`AND kcu.table_schema = tc.table_schema ` +
				`AND kcu.table_name = tc.table_name ` +
			`JOIN information_schema.constraint_column_usage ccu ` +
				`ON ccu.constraint_name = tc.constraint_name ` +
				`AND ccu.table_schema = tc.table_schema ` +
			`WHERE tc.constraint_type = 'FOREIGN KEY' ` +
				`AND tc.table_schema = ${ns} AND tc.table_name = ${target} ` +
			`ORDER BY kcu.column_name, ccu.table_name, ccu.column_name` +
		`) fk ON fk.column_name = c.column_name ` +
		`WHERE c.table_schema = ${ns} AND c.table_name = ${target} ` +
		`ORDER BY c.ordinal_position`
	);
}

/**
 * SQL de `list indexes [on <table>]`. `pg_index` porte les
 * flags (unique/primary), `pg_class` les noms, `pg_attribute` les colonnes.
 * `string_agg(...)` reconstruit la liste des cols dans l'ordre déclaré
 * (`indkey` est un int[] positionnel). $1 = namespace, $2 = table (opt).
 */
function listIndexesSql(ns: string, target: string | undefined): string {
	const tableFilter = target !== undefined ? ` AND t.relname = ${target}` : "";
	return (
		`SELECT ` +
			`i.relname AS name, ` +
			`t.relname AS "table", ` +
			`ix.indisunique AS "unique", ` +
			`(SELECT string_agg(a.attname, ', ' ORDER BY array_position(ix.indkey::int[], a.attnum::int)) ` +
			`FROM pg_attribute a ` +
			`WHERE a.attrelid = t.oid AND a.attnum = ANY(ix.indkey::int[])) AS columns ` +
		`FROM pg_index ix ` +
		`JOIN pg_class i ON i.oid = ix.indexrelid ` +
		`JOIN pg_class t ON t.oid = ix.indrelid ` +
		`JOIN pg_namespace n ON n.oid = t.relnamespace ` +
		`WHERE n.nspname = ${ns}${tableFilter} ` +
		`ORDER BY t.relname, i.relname`
	);
}

/**
 * Codegen des mutations. Valeurs TOUJOURS paramétrées, identifiants quotés.
 * `RETURNING *` : `execute` récupère les lignes affectées (et leur nombre).
 * `returnRowCount === true` droppe le `RETURNING *` — le
 * driver renvoie alors seulement rowCount (rows = []).
 */
function renderMutation(plan: MutationPlan, params: ParamList): string {
	switch (plan.op) {
		case "insert": {
			const cols = plan.columns.map(quoteIdent).join(", ");
			const returning = plan.returnRowCount === true ? "" : " RETURNING *";
			// INSERT SELECT — pas de VALUES, on injecte le
			// SELECT rendu depuis sourcePlan. Les $N sont partagés avec le
			// ParamList courant (bindés séquentiellement, ordre préservé).
			if (plan.sourcePlan !== undefined) {
				const selectText = renderPlan(plan.sourcePlan, params);
				return `INSERT INTO ${quoteIdent(plan.collection)} (${cols}) ${selectText}${returning}`;
			}
			// Phase 3c : threader cellSpans[rowIdx][colIdx] au ParamList pour que
			// chaque `$N` bindé porte le span de son littéral source.
			const rows = plan.rows
				.map(
					(row, rowIdx) =>
						`(${row
							.map((value, colIdx) =>
								renderValue(value, params, plan.cellSpans?.[rowIdx]?.[colIdx])
							)
							.join(", ")})`
				)
				.join(", ");
			const onConflict = plan.onConflict !== undefined
				? ` ${renderOnConflict(plan.onConflict, plan.collection, params)}`
				: "";
			return `INSERT INTO ${quoteIdent(plan.collection)} (${cols}) VALUES ${rows}${onConflict}${returning}`;
		}
		case "update": {
			const set = plan.assignments
				.map((a) => `${quoteIdent(a.column)} = ${renderExpr(a.value, params)}`)
				.join(", ");
			// `UPDATE t [AS a] [SET...] [FROM x AS b, y AS c]
			// [WHERE (join keys) AND (predicate)]`.
			const target = plan.alias !== undefined
				? `${quoteIdent(plan.collection)} AS ${quoteIdent(plan.alias)}`
				: quoteIdent(plan.collection);
			const joins = plan.joins ?? [];
			const fromClause = joins.length > 0
				? ` FROM ${joins.map((j) => `${quoteIdent(j.collection)} AS ${quoteIdent(j.as)}`).join(", ")}`
				: "";
			const joinPreds = joins.map((j) =>
				`${renderJoinPath(j.localField, plan.alias ?? plan.collection)} = ${renderJoinPath(j.foreignField, j.as)}`
			);
			const userPred = plan.predicate !== undefined ? renderExpr(plan.predicate, params) : "";
			const allPreds = [...joinPreds, ...(userPred !== "" ? [userPred] : [])];
			const where = allPreds.length > 0 ? ` WHERE ${allPreds.join(" AND ")}` : "";
			const returning = plan.returnRowCount === true ? "" : " RETURNING *";
			return `UPDATE ${target} SET ${set}${fromClause}${where}${returning}`;
		}
		case "delete": {
			const where = renderWhere(plan.predicate, params);
			const returning = plan.returnRowCount === true ? "" : " RETURNING *";
			return `DELETE FROM ${quoteIdent(plan.collection)}${where}${returning}`;
		}
	}
}

/**
 * rend une clause ON CONFLICT PG. `ignore` → `DO NOTHING`.
 * `update` → `DO UPDATE SET c = expr [WHERE p]`. Les `new.<col>` sont déjà
 * lowered en PlanExpr.upsertNew → renderExpr émet `EXCLUDED."col"`.
 */
function renderOnConflict(
	clause: import("../ir/plan").PlanOnConflict,
	_collection: string,
	params: ParamList
): string {
	const keys = clause.keys.map(quoteIdent).join(", ");
	if (clause.action.kind === "ignore") {
		return `ON CONFLICT (${keys}) DO NOTHING`;
	}
	const set = clause.action.assignments
		.map((a) => `${quoteIdent(a.column)} = ${renderExpr(a.value, params)}`)
		.join(", ");
	const where = clause.action.where !== undefined
		? ` WHERE ${renderExpr(clause.action.where, params)}`
		: "";
	return `ON CONFLICT (${keys}) DO UPDATE SET ${set}${where}`;
}

/** Clause WHERE d'une mutation, ou chaîne vide si le prédicat est absent (toutes les lignes). */
function renderWhere(
	predicate: PlanExpr | undefined,
	params: ParamList
): string {
	return predicate === undefined
		? ""
		: ` WHERE ${renderExpr(predicate, params)}`;
}

/** Valeur littérale d'un INSERT : NULL en clair, le reste paramétré. */
function renderValue(
	value: PlanRowValue,
	params: ParamList,
	span?: import("../lexer/token").Span
): string {
	// Sprint object-literals : dispatch scalar vs jsonLiteral. Scalar = params
	// bindés simples (comportement historique). jsonLiteral = expression
	// object/array lowered → renderExpr émet jsonb_build_object avec keys+values
	// bindées (anti-injection). Le span extern des cellSpans reste valide pour
	// les leaves scalar ; pour jsonLiteral, chaque leaf de l'expression porte
	// son propre span via PlanExpr récursif.
	if (value.kind === "scalar") {
		return value.value === null ? "NULL" : params.add(value.value, span);
	}
	return renderExpr(value.expr, params);
}

/**
 * Mapping SnqlType canonique → type Postgres pour DDL (ADR-029 D1).
 * Choix figés pour round-trip cross-engine :
 *  - `int → integer` (INT32 natif PG — vs PG_CAST_TYPE.int=bigint pour élargir sur cast)
 *  - `bigint → bigint` (INT64)
 *  - `float → double precision` (IEEE 754 64-bit, aligné Mongo Double)
 *  - `decimal → numeric` (précision arbitraire, aligné Mongo Decimal128)
 *  - `date → timestamptz` (préserve instant UTC + tz, round-trip Mongo Date lossless — trap accepté vs DATE-only : le canonique SnqlType.date recouvre PG DATE/TIMESTAMP/TIMESTAMPTZ)
 *  - `json → jsonb` (indexable, canonicalisé)
 *  - `array → jsonb` (les tableaux PG natifs sont hors round-trip Mongo)
 *  - `enum → text` (les enums PG nécessitent CREATE TYPE dédié — hors scope DDL/1)
 *  - `unknown → text` (fallback safe : évite un refus DDL, l'user peut migrer plus tard)
 */
const PG_DDL_TYPE: Readonly<Record<SnqlType, string>> = {
	string: "text",
	int: "integer",
	bigint: "bigint",
	float: "double precision",
	decimal: "numeric",
	bool: "boolean",
	date: "timestamptz",
	json: "jsonb",
	array: "jsonb",
	uuid: "uuid",
	// Fallback si `type: "enum"` sans `enumTypeName` (ne devrait pas arriver
	// depuis le lower Enum/2, mais garde-fou). Le vrai enum-ref émet
	// `quoteIdent(enumTypeName)` via pgFieldTypeSql().
	enum: "text",
	unknown: "text"
};

/**
 * Rend le SQL type d'un `CreateTableField`. Pour un enum (ADR-030 Enum/2),
 * émet l'enum name quoted (ex : `"role_type"`), sinon lookup PG_DDL_TYPE.
 */
function pgFieldTypeSql(f: import("../ir/plan").CreateTableField): string {
	if (f.type === "enum" && f.enumTypeName !== undefined) {
		return quoteIdent(f.enumTypeName);
	}
	return PG_DDL_TYPE[f.type];
}

/** Traduit une règle de cascade SNQL en clause SQL PG. */
const PG_REF_ACTION: Readonly<
	Record<import("../schema/model").OnDeleteRule, string>
> = {
	restrict: "RESTRICT",
	cascade: "CASCADE",
	"set-null": "SET NULL"
};

/**
 * Clause FK column-level PG (ADR-031 FK/1) : `CONSTRAINT "fk_name" REFERENCES
 * "target" ("col") ON DELETE <action> ON UPDATE <action>`. Émise inline dans
 * la définition de colonne (create table + add column). PG natif — pas de
 * compensation.
 */
function pgRefClause(ref: import("../ir/plan").FieldRefPlan): string {
	return (
		`CONSTRAINT ${quoteIdent(ref.name)} REFERENCES ` +
		`${quoteIdent(ref.targetCollection)} (${quoteIdent(ref.targetColumn)}) ` +
		`ON DELETE ${PG_REF_ACTION[ref.onDelete]} ` +
		`ON UPDATE ${PG_REF_ACTION[ref.onUpdate]}`
	);
}

/**
 * PG rejette les paramètres bindés `$N` dans les statements DDL (CREATE TABLE,
 * ALTER TABLE) via le extended query protocol — erreur 08P01 `bind message
 * supplies N parameters, but prepared statement "" requires 0`. Le DDL PG
 * exige des littéraux inline. On escape proprement pour préserver la sûreté.
 *  - string : `'…'` avec `E'…'` si backslash présent (escape strings), doublement
 *    des simple quotes internes.
 *  - number : text brut (raw safe car number JS).
 *  - bigint : `123::bigint` (préserve la précision > 2^53).
 *  - SqlDecimal : `123.456::numeric` (précision arbitraire).
 *  - boolean : `TRUE` / `FALSE`.
 *  - null : `NULL`.
 */
function pgInlineDefault(value: DdlDefault): string {
	if (value === null) return "NULL";
	if (typeof value === "string") {
		const escaped = value.replace(/'/g, "''");
		if (value.includes("\\")) return `E'${escaped.replace(/\\/g, "\\\\")}'`;
		return `'${escaped}'`;
	}
	if (typeof value === "number") return String(value);
	if (typeof value === "bigint") return `${value.toString()}::bigint`;
	if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
	if (isSqlDecimal(value)) return `${value.raw}::numeric`;
	if (isSqlJsonLiteral(value)) {
		const escaped = value.raw.replace(/'/g, "''");
		return `'${escaped}'::jsonb`;
	}
	throw new SnqlError(
		`Type de default DDL non supporté par pgInlineDefault : ${typeof value}`,
		"codegen_ddl_default_unsupported"
	);
}

/**
 * Rend un `create table` (avec ou sans idempotence D3). Sans `if not exists`,
 * une seule SqlQuery. Avec, un SqlTransaction 2-steps où l'advisory lock
 * sérialise les créations concurrentes (drift schéma prévenu — cf. ADR-029 D3).
 * Les defaults sont inline (voir [[pgInlineDefault]]) — PG DDL rejette les
 * $N bindés.
 */
function renderCreateTable(plan: CreateTablePlan): NativeQuery {
	const cols: string[] = [];
	for (const f of plan.fields) {
		const parts: string[] = [quoteIdent(f.name), pgFieldTypeSql(f)];
		if (!f.nullable) parts.push("NOT NULL");
		if (f.unique) parts.push("UNIQUE");
		if (f.defaultValue !== undefined) {
			parts.push(`DEFAULT ${pgInlineDefault(f.defaultValue)}`);
		}
		if (f.ref !== undefined) parts.push(pgRefClause(f.ref));
		cols.push(parts.join(" "));
	}
	if (plan.primaryKey !== undefined && plan.primaryKey.length > 0) {
		cols.push(
			`PRIMARY KEY (${plan.primaryKey.map(quoteIdent).join(", ")})`
		);
	}
	const ifNotExists = plan.ifNotExists ? "IF NOT EXISTS " : "";
	const createText = `CREATE TABLE ${ifNotExists}${quoteIdent(plan.target)} (${cols.join(", ")})`;
	const createStep: SqlQuery = {
		engine: "postgres",
		kind: "sql",
		text: createText,
		params: [],
		paramSpans: []
	};
	if (!plan.ifNotExists) return createStep;
	// D3 : sérialise concurrent DDL avec un advisory lock scopé transaction.
	// Le hash est calculé côté PG (deterministe) — sans overflow risque sur un
	// nom > 63 chars puisque le lower a serré la vis (IDENT_REGEX 63 max D1).
	const lockParams = newParams();
	const targetRef = lockParams.add(plan.target);
	const lockStep: SqlQuery = {
		engine: "postgres",
		kind: "sql",
		text: `SELECT pg_advisory_xact_lock(hashtextextended('sqlnest_ddl:' || ${targetRef}, 0))`,
		params: lockParams.all(),
		paramSpans: lockParams.allSpans()
	};
	const transaction: SqlTransaction = {
		engine: "postgres",
		kind: "transaction",
		steps: [
			{ kind: "statement", query: lockStep },
			{ kind: "statement", query: createStep }
		]
	};
	return transaction;
}

/**
 * Rend un `add column` en `ALTER TABLE ... ADD COLUMN ...` (ADR-029 DDL/2).
 * D10 backfill natif PG : `DEFAULT v` sur ADD COLUMN backfille les rows
 * existants (metadata-trick PG 11+ pour un DEFAULT constant, table rewrite
 * sinon). Pas d'advisory lock ici — un ADD COLUMN prend déjà un AccessExclusive
 * lock sur la table (PG sérialise nativement).
 *
 * `IF NOT EXISTS` PG 9.6+ natif — pas d'astuce à ajouter côté codegen (name-only
 * D3, drift schéma NON détecté ; l'user peut re-check via `describe`).
 */
function renderAddColumn(plan: AddColumnPlan): NativeQuery {
	const f = plan.column;
	const parts: string[] = [quoteIdent(f.name), pgFieldTypeSql(f)];
	if (!f.nullable) parts.push("NOT NULL");
	if (f.unique) parts.push("UNIQUE");
	if (f.defaultValue !== undefined) {
		parts.push(`DEFAULT ${pgInlineDefault(f.defaultValue)}`);
	}
	if (f.ref !== undefined) parts.push(pgRefClause(f.ref));
	const ifNotExists = plan.ifNotExists ? "IF NOT EXISTS " : "";
	const text = `ALTER TABLE ${quoteIdent(plan.target)} ADD COLUMN ${ifNotExists}${parts.join(" ")}`;
	return {
		engine: "postgres",
		kind: "sql",
		text,
		params: [],
		paramSpans: []
	};
}

/**
 * Rend `add [unique] index (fields) into T` en `CREATE [UNIQUE] INDEX
 * CONCURRENTLY [IF NOT EXISTS] "name" ON "T" ("f1", "f2")` (ADR-029 D11).
 * CONCURRENTLY par défaut pour éviter les locks ACCESS EXCLUSIVE longs qui
 * bloquent reads + writes — attention : CONCURRENTLY ne peut PAS s'exécuter
 * dans un bloc transaction (PG remonte erreur claire, aligné avec la doctrine
 * refus explicit du parser V1 qui refuse tout DDL dans transaction).
 *
 * Pas de params bindés (feedback pg-ddl-inline-defaults) — les idents sont
 * quoted via quoteIdent.
 */
function renderAddIndex(plan: AddIndexPlan): NativeQuery {
	const unique = plan.kind === "add-unique-index" ? "UNIQUE " : "";
	const ifNotExists = plan.ifNotExists ? "IF NOT EXISTS " : "";
	const cols = plan.fields.map(quoteIdent).join(", ");
	const text = `CREATE ${unique}INDEX CONCURRENTLY ${ifNotExists}${quoteIdent(plan.name)} ON ${quoteIdent(plan.target)} (${cols})`;
	return {
		engine: "postgres",
		kind: "sql",
		text,
		params: [],
		paramSpans: []
	};
}

/**
 * Rend `drop index NAME from T` en `DROP INDEX [IF EXISTS] "name"` (PG le
 * scope au schema courant — pas besoin du nom de table dans le SQL). Pas de
 * CONCURRENTLY sur DROP INDEX v1 : l'opération est déjà rapide (~ms).
 */
function renderDropIndex(plan: DropIndexPlan): NativeQuery {
	const ifExists = plan.ifExists ? "IF EXISTS " : "";
	const text = `DROP INDEX ${ifExists}${quoteIdent(plan.name)}`;
	return {
		engine: "postgres",
		kind: "sql",
		text,
		params: [],
		paramSpans: []
	};
}

/**
 * Rend `drop ref NAME from T` en `ALTER TABLE "T" DROP CONSTRAINT [IF EXISTS]
 * "name"` (ADR-031 FK/3). Pas de CASCADE : une contrainte FK n'a pas de
 * dépendants. Le frontend applique D7 typing UI gate avant Execute (retirer
 * une FK relâche silencieusement l'intégrité référentielle).
 */
function renderDropRef(plan: DropRefPlan): NativeQuery {
	const ifExists = plan.ifExists ? "IF EXISTS " : "";
	const text = `ALTER TABLE ${quoteIdent(plan.target)} DROP CONSTRAINT ${ifExists}${quoteIdent(plan.name)}`;
	return {
		engine: "postgres",
		kind: "sql",
		text,
		params: [],
		paramSpans: []
	};
}

/**
 * Rend `drop table NAME [if exists]` en `DROP TABLE [IF EXISTS] "T" RESTRICT`
 * (ADR-029 DDL/4). RESTRICT par défaut (PG refuse si FK dépendent — safe vs
 * cascade silencieux). Le frontend applique D7 typing UI gate WriteConfirmBar
 * avant Execute pour prévenir l'accident.
 */
function renderDropTable(plan: DropTablePlan): NativeQuery {
	const ifExists = plan.ifExists ? "IF EXISTS " : "";
	const text = `DROP TABLE ${ifExists}${quoteIdent(plan.target)} RESTRICT`;
	return {
		engine: "postgres",
		kind: "sql",
		text,
		params: [],
		paramSpans: []
	};
}

/**
 * Rend `drop column NAME from T` en `ALTER TABLE "T" DROP COLUMN [IF EXISTS]
 * "col" RESTRICT` (ADR-029 DDL/4). RESTRICT safe vs vues/FK dépendantes.
 * Le frontend applique D7 typing UI gate avant Execute.
 */
function renderDropColumn(plan: DropColumnPlan): NativeQuery {
	const ifExists = plan.ifExists ? "IF EXISTS " : "";
	const text = `ALTER TABLE ${quoteIdent(plan.target)} DROP COLUMN ${ifExists}${quoteIdent(plan.column)} RESTRICT`;
	return {
		engine: "postgres",
		kind: "sql",
		text,
		params: [],
		paramSpans: []
	};
}

/**
 * Rend `create enum NAME { "m1", "m2" }` en `CREATE TYPE "NAME" AS ENUM ('m1',
 * 'm2')` (ADR-030 Enum/1). PG DDL rejette les $N bindés (08P01) — les members
 * sont inline via `pgInlineDefault`.
 *
 * PG n'a pas de `CREATE TYPE IF NOT EXISTS` natif. Idempotence D3 via un
 * `DO $$` PL/pgSQL qui catch `duplicate_object` (SQLSTATE 42710). Le block
 * ne peut pas bind de params — cohérent avec inline members.
 */
function renderCreateEnum(plan: CreateEnumPlan): NativeQuery {
	const members = plan.members.map((m) => pgInlineDefault(m)).join(", ");
	const createStmt = `CREATE TYPE ${quoteIdent(plan.name)} AS ENUM (${members})`;
	const text = plan.ifNotExists
		? `DO $$ BEGIN ${createStmt}; EXCEPTION WHEN duplicate_object THEN NULL; END $$`
		: createStmt;
	return {
		engine: "postgres",
		kind: "sql",
		text,
		params: [],
		paramSpans: []
	};
}

/**
 * Rend `add enum member <Name> "m"` en `ALTER TYPE "<Name>" ADD VALUE IF NOT
 * EXISTS 'm'` (ADR-030 Enum/3). PG DDL rejette les $N bindés (08P01) — le
 * member est inline via `pgInlineDefault`.
 *
 * `IF NOT EXISTS` natif PG = dedup silence. `ifNotExists` du plan est
 * ignoré (implicite au niveau engine) — présent seulement pour tracer
 * l'intention user au niveau source.
 */
function renderAddEnumMember(plan: AddEnumMemberPlan): NativeQuery {
	const memberSql = pgInlineDefault(plan.member);
	const text = `ALTER TYPE ${quoteIdent(plan.name)} ADD VALUE IF NOT EXISTS ${memberSql}`;
	return {
		engine: "postgres",
		kind: "sql",
		text,
		params: [],
		paramSpans: []
	};
}

/**
 * Rend `drop enum NAME [if exists] [cascade]` en `DROP TYPE [IF EXISTS] "NAME"
 * [RESTRICT|CASCADE]` (ADR-030 Enum/3 D8). RESTRICT par défaut (PG refuse via
 * SQLSTATE 2BP01 si l'enum est utilisé par ≥1 colonne — safe vs drop
 * silencieux des colonnes). CASCADE explicite pour drop les colonnes
 * utilisatrices. Le frontend applique D7 typing UI gate WriteConfirmBar avant
 * Execute pour prévenir l'accident.
 */
function renderDropEnum(plan: DropEnumPlan): NativeQuery {
	const ifExists = plan.ifExists ? "IF EXISTS " : "";
	const mode = plan.cascade ? "CASCADE" : "RESTRICT";
	const text = `DROP TYPE ${ifExists}${quoteIdent(plan.name)} ${mode}`;
	return {
		engine: "postgres",
		kind: "sql",
		text,
		params: [],
		paramSpans: []
	};
}
