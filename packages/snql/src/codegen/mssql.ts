import { SnqlError } from "../diagnostics";
import type {
	CastTarget,
	IntrospectPlan,
	LogicalPlan,
	MutationPlan,
	PlanExpr,
	PlanRowValue,
	RawPlan,
	TransactionPlan
} from "../ir/plan";
import { isSqlDecimal, isSqlJsonLiteral } from "../ir/plan";
import type { Span } from "../lexer/token";
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
 * Mapper MSSQL (T-SQL) — chantiers M/3 (lecture) + M/4 (CRUD). Réutilise la
 * mécanique SELECT de `sql-core` avec le dialecte T-SQL :
 *  - identifiants `[bracket]`, paramètres `@pN` (alignés sur l'adapter
 *    tedious qui bind `p1..pN`) ;
 *  - pagination `TOP (@pN)` sans offset, `OFFSET … ROWS FETCH NEXT … ROWS
 *    ONLY` avec (ORDER BY exigé → `(SELECT NULL)` forcé si absent) ;
 *  - embeds one-to-many via `FOR JSON PATH` (T-SQL n'a pas de type json :
 *    la colonne sort en nvarchar — les alias sont collectés dans
 *    `SqlQuery.jsonColumns` et l'adapter parse les strings) ;
 *  - DISTINCT ON via wrap ROW_NUMBER (stratégie core `row-number`).
 *
 * M/4 — écritures :
 *  - `OUTPUT INSERTED.*` / `OUTPUT DELETED.*` ≈ RETURNING * PG (la clause se
 *    place AVANT VALUES/SELECT/FROM/WHERE, pas en fin) ;
 *  - upsert `on conflict` → `MERGE WITH (HOLDLOCK)` (l'hint sérialise le
 *    upsert concurrent — parité de garantie avec l'atomicité ON CONFLICT
 *    PG) ; `new.<col>` → l'alias source du MERGE ;
 *  - mutation join → `UPDATE alias … FROM [t] AS alias, [x] AS b WHERE …` ;
 *  - transactions natives : steps pré-rendus partagés (buildSqlTransaction
 *    Steps), l'adapter émet BEGIN TRANSACTION / SAVE TRANSACTION / COMMIT.
 *
 * Cible dev = SQL Server 2022 ; JSON_OBJECT/JSON_ARRAY (2022+) et FOR JSON
 * (2016+) sont notés pour la passe 2014 (M/7 — compensations doctrine
 * UNIFIE). Introspect tier-1 + let/CTE = M/5, DDL = M/6.
 */

/**
 * Mapping des 7 targets canoniques SNQL vers T-SQL. Choix figés (parité PG) :
 *  - `int → bigint` (INT64, aligné PG_CAST_TYPE.int)
 *  - `float → float` (= float(53), IEEE 754 64-bit)
 *  - `text → nvarchar(max)` (unicode, aligné driver NVarChar)
 *  - `bool → bit`
 *  - `timestamp → datetimeoffset` (préserve l'instant UTC, miroir timestamptz)
 * `json` ABSENT (refus planner via castTargets) : pas de type json T-SQL,
 * un cast nvarchar n'aurait pas la sémantique parse/validate de `::jsonb`.
 */
export const MSSQL_CAST_TYPE: Readonly<Partial<Record<CastTarget, string>>> = {
	int: "bigint",
	float: "float",
	text: "nvarchar(max)",
	bool: "bit",
	date: "date",
	timestamp: "datetimeoffset"
};

/** Types T-SQL des annotations de paramètres (littéraux JSON, arith décimale).
 *  `numeric → decimal(38, 10)` : T-SQL exige precision/scale fixes
 *  (contrairement au numeric PG arbitraire) — 38 = max, scale 10 couvre les
 *  littéraux décimaux de requête. */
const MSSQL_TYPED_PARAM: Readonly<Record<TypedParamKind, string>> = {
	text: "nvarchar(max)",
	bool: "bit",
	bigint: "bigint",
	float: "float",
	numeric: "decimal(38, 10)",
	json: "nvarchar(max)"
};

/** Alias target/source du MERGE upsert — préfixés pour ne jamais collisionner
 *  avec une table user (IDENT_RE accepte les underscores en tête). */
const MERGE_TARGET = "__sqlnest_t";
const MERGE_SOURCE = "__sqlnest_s";

/**
 * Collecteur des colonnes JSON du statement en cours (embeds/objets de row
 * jointe → `SqlQuery.jsonColumns`). Module-level MAIS safe : le codegen est
 * strictement synchrone (aucun await entre le reset et la lecture) — un seul
 * map() vit à la fois dans un process JS.
 */
let jsonColumns: Set<string> = new Set();

const MSSQL_DIALECT: SqlDialect = {
	engine: "mssql",
	wrapIdent: (name) => `[${name}]`,
	paramRef: (index) => `@p${index}`,
	// T-SQL n'a pas de littéral booléen en contexte prédicat.
	falseLiteral: () => "(1 = 0)",
	typedParam: (ref, kind) => `CAST(${ref} AS ${MSSQL_TYPED_PARAM[kind]})`,
	castType: (target) => MSSQL_CAST_TYPE[target],
	// Embed one-to-many : sous-requête corrélée FOR JSON PATH — renvoie une
	// string JSON `[{…}, …]` (NULL si 0 row → COALESCE `[]`, parité json_agg
	// PG). INCLUDE_NULL_VALUES : FOR JSON omet les colonnes NULL par défaut,
	// PG json_agg les garde — l'option aligne les shapes.
	embedAgg: ({ innerRef, fromClause, correlation }) =>
		`COALESCE((SELECT ${innerRef}.* FROM ${fromClause} WHERE ${correlation} FOR JSON PATH, INCLUDE_NULL_VALUES), N'[]')`,
	// Objet d'une row jointe entière (`pick alias` sur un LEFT JOIN) :
	// sous-requête corrélée sans FROM — équivalent row_to_json PG. LEFT JOIN
	// sans match → toutes colonnes NULL → FOR JSON renvoie NULL (parité
	// row_to_json(NULL row) → NULL).
	rowObject: (aliasSql) =>
		`(SELECT ${aliasSql}.* FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES)`,
	// JSON_OBJECT / JSON_ARRAY = SQL Server 2022+ (noté M/7). Les parts
	// alternent key/value déjà rendues et typées par typedParam.
	jsonObject: (parts) => {
		if (parts.length === 0) return "JSON_OBJECT()";
		const pairs: string[] = [];
		for (let i = 0; i < parts.length; i += 2) {
			pairs.push(`${parts[i]}: ${parts[i + 1]}`);
		}
		return `JSON_OBJECT(${pairs.join(", ")})`;
	},
	jsonArray: (parts) => `JSON_ARRAY(${parts.join(", ")})`,
	distinctOnStrategy: "row-number",
	limitFragments: ({ limitRef, offsetRef, hasOrderBy }) => {
		// Sans offset : TOP — ne dépend pas d'un ORDER BY.
		if (offsetRef === undefined) {
			return { selectPrefixSuffix: `TOP (${limitRef})` };
		}
		// OFFSET-FETCH exige un ORDER BY — `(SELECT NULL)` = ordre indifférent,
		// idiome T-SQL standard.
		const afterOrder = limitRef !== ""
			? `OFFSET ${offsetRef} ROWS FETCH NEXT ${limitRef} ROWS ONLY`
			: `OFFSET ${offsetRef} ROWS`;
		return hasOrderBy
			? { afterOrder }
			: { afterOrder, forcedOrderBy: "(SELECT NULL)" };
	},
	// `new.<col>` (upsert `on conflict edit set/where`) → la row proposée =
	// l'alias source du MERGE (équivalent EXCLUDED PG).
	upsertNewRef: (columnSql) => `[${MERGE_SOURCE}].${columnSql}`,
	onJsonColumn: (alias) => {
		jsonColumns.add(alias);
	},
	// T-SQL écrit ses CTE récursifs avec un WITH nu (pas de mot-clé
	// RECURSIVE). Garde-fou runaway : MAXRECURSION serveur = 100 par défaut
	// (erreur claire au-delà) — miroir de la protection statement_timeout du
	// let rec PG, par profondeur plutôt que par durée.
	recursiveCtePrefix: "WITH"
};

const MSSQL = createSqlRenderer(MSSQL_DIALECT);
const {
	newParams,
	quoteIdent,
	renderPlan,
	renderExpr,
	renderJoinPath
} = MSSQL;

export const mssqlMapper: Mapper = {
	engine: "mssql",
	map(plan: LogicalPlan): NativeQuery {
		jsonColumns = new Set();
		const params = newParams();
		const text = renderPlan(plan, params);
		const collected = [...jsonColumns];
		return {
			engine: "mssql",
			kind: "sql",
			text,
			params: params.all(),
			paramSpans: params.allSpans(),
			...(collected.length > 0 ? { jsonColumns: collected } : {})
		};
	},
	mapMutation(plan: MutationPlan): NativeQuery {
		const params = newParams();
		const text = renderMutation(plan, params);
		// Phase 3c (miroir PG) : rowSpans des INSERT exposés pour cibler la row
		// source d'une violation unique/FK.
		const rowSpans =
			plan.op === "insert" && plan.rowSpans !== undefined
				? plan.rowSpans.map((span) =>
						span !== undefined
							? ([span.start.offset, span.end.offset - span.start.offset] as SerializedSpan)
							: undefined
					)
				: undefined;
		return {
			engine: "mssql",
			kind: "sql",
			text,
			params: params.all(),
			paramSpans: params.allSpans(),
			...(rowSpans !== undefined ? { rowSpans } : {})
		};
	},
	/**
	 * Transaction native T-SQL. Steps pré-rendus (flatten partagé) — l'adapter
	 * émet `BEGIN TRANSACTION` / `SAVE TRANSACTION [name]` (release = no-op,
	 * T-SQL n'a pas de RELEASE SAVEPOINT : le point expire au COMMIT) /
	 * `COMMIT` (ROLLBACK global sur erreur, sémantique alignée PG).
	 */
	mapTransaction(plan: TransactionPlan): SqlTransaction {
		const steps = buildSqlTransactionSteps(plan.body, {
			renderRead: renderReadAsSqlQuery,
			renderWrite: renderWriteAsSqlQuery
		});
		return plan.isolation !== undefined
			? { engine: "mssql", kind: "transaction", isolation: plan.isolation, steps }
			: { engine: "mssql", kind: "transaction", steps };
	},
	/**
	 * `let x = …; body` → `WITH … BODY` (CTE natifs T-SQL, récursifs sans
	 * mot-clé RECURSIVE — voir recursiveCtePrefix). Bindings + body partagent
	 * la ParamList (placeholders @pN séquentiels).
	 */
	mapLet(plan: import("../ir/plan").LetPlan): NativeQuery {
		jsonColumns = new Set();
		const params = newParams();
		const text = MSSQL.renderLet(plan, params, renderMutation);
		const collected = [...jsonColumns];
		return {
			engine: "mssql",
			kind: "sql",
			text,
			params: params.all(),
			paramSpans: params.allSpans(),
			...(collected.length > 0 ? { jsonColumns: collected } : {})
		};
	},
	/**
	 * Introspection tier-1 (M/5) — miroir du pattern PG : INFORMATION_SCHEMA
	 * + sys.* avec le namespace bindé. Les enums viennent de la table
	 * metadata `_snql_enums` (compensation — T-SQL n'a pas de type enum, M/6
	 * l'écrira au `create enum`) : `IF OBJECT_ID(...)` garde les deux
	 * branches (table absente → 0 row, même shape — parité Mongo
	 * `_snql_enums` manquante). Les postOps wrappent CHAQUE branche du IF
	 * (un IF n'est pas une expression sous-requêtable) et le baseText des
	 * kinds wrappés ne porte JAMAIS d'ORDER BY (interdit en sous-requête
	 * T-SQL) — l'ordre par défaut passe en `defaultOrder` du wrapper.
	 */
	mapIntrospect(
		plan: IntrospectPlan,
		ctx?: import("./mapper").MapperContext
	): NativeQuery {
		// `list schema_events` — table système SQLNest, routée par le backend
		// (jamais le tunnel proxy vers la DB user). Copie du contrat PG.
		if (plan.kind === "list-schema-events") {
			return plan.postOps !== undefined && plan.postOps.length > 0
				? {
						engine: "mssql",
						kind: "sqlnest-introspect",
						target: "schema-events",
						postOps: plan.postOps
					}
				: {
						engine: "mssql",
						kind: "sqlnest-introspect",
						target: "schema-events"
					};
		}
		// Miroir du garde-fou PG : le refus vit au planner (matrice), ce
		// check évite un fallback silencieux si le kind descend jusqu'ici.
		if (plan.kind === "list-databases") {
			throw new SnqlError(
				"'list databases' non supporté sur MSSQL — utilise 'list schemas' pour les namespaces intra-DB.",
				"codegen_introspect_unsupported"
			);
		}
		const namespace = ctx?.namespace ?? "dbo";
		const params = newParams();
		const hasPostOps = plan.postOps !== undefined && plan.postOps.length > 0;

		if (plan.kind === "list-enums" || plan.kind === "describe-enum") {
			return renderEnumsIntrospect(plan, namespace, params, hasPostOps);
		}

		let baseText: string;
		// `defaultOrder` : ORDER BY appliqué hors wrap (suffix direct) ET
		// passé au wrapper quand ses colonnes sont projetées. describe-table
		// trie sur ORDINAL_POSITION (non projetée) → suffix seulement ; sous
		// postOps sans sort, l'ordre n'est pas garanti (même sémantique que
		// la sous-requête PG).
		let defaultOrder: string;
		let wrapOrder: string | undefined;
		if (plan.kind === "list-tables") {
			const nsRef = params.add(namespace);
			// Tables metadata SQLNest (`_snql_*`) exclues — compensations
			// internes, jamais des tables user (miroir introspect adapter).
			baseText = `SELECT TABLE_NAME AS name FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ${nsRef} AND TABLE_TYPE = 'BASE TABLE' AND TABLE_NAME NOT LIKE '\\_snql\\_%' ESCAPE '\\'`;
			defaultOrder = "[name] ASC";
			wrapOrder = defaultOrder;
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
			defaultOrder = "c.ORDINAL_POSITION ASC";
			wrapOrder = undefined;
		} else if (plan.kind === "list-schemas") {
			// Exclut la plomberie MSSQL (schemas système + rôles db_*) — l'user
			// veut voir SES schemas, miroir du filtre pg_* côté PG.
			baseText = `SELECT s.name AS name FROM sys.schemas s WHERE s.name NOT IN ('sys', 'INFORMATION_SCHEMA', 'guest') AND s.name NOT LIKE 'db\\_%' ESCAPE '\\'`;
			defaultOrder = "[name] ASC";
			wrapOrder = defaultOrder;
		} else if (plan.kind === "list-indexes") {
			const nsRef = params.add(namespace);
			const targetRef = plan.target !== undefined ? params.add(plan.target) : undefined;
			baseText = listIndexesSql(nsRef, targetRef);
			defaultOrder = "[table] ASC, [name] ASC";
			wrapOrder = defaultOrder;
		} else {
			throw new SnqlError(
				`Introspect kind '${plan.kind}' non supporté par le codegen MSSQL M/5`,
				"codegen_introspect_unsupported"
			);
		}
		const text = hasPostOps
			? MSSQL.wrapIntrospectPostOps(
					baseText,
					plan.postOps ?? [],
					params,
					wrapOrder
				)
			: `${baseText} ORDER BY ${defaultOrder}`;
		return {
			engine: "mssql",
			kind: "sql",
			text,
			params: params.all(),
			paramSpans: params.allSpans()
		};
	},
	/**
	 * DDL Tier-2 MSSQL (M/6) — natif pour tables/colonnes/index/FK, compensé
	 * via la table metadata `_snql_enums` pour les enums (T-SQL n'a pas de
	 * type enum ; les colonnes enum = nvarchar(450) + CHECK IN sur le
	 * snapshot des members). Idempotence D3 : T-SQL n'a pas de `CREATE …
	 * IF NOT EXISTS` → guards `IF OBJECT_ID/COL_LENGTH/sys.indexes` ; le
	 * `create table if not exists` concurrent est sérialisé par
	 * `sp_getapplock` (miroir de l'advisory lock PG, transaction-scoped).
	 * Defaults INLINE (T-SQL refuse un @p dans une contrainte DEFAULT —
	 * même contrainte que le 08P01 PG, pattern pg-ddl-inline-defaults).
	 */
	mapDDL(
		plan: import("../ir/plan").DDLPlan,
		ctx?: import("./mapper").MapperContext
	): NativeQuery {
		const namespace = ctx?.namespace ?? "dbo";
		if (plan.kind === "create-table") return renderCreateTable(plan, namespace);
		if (plan.kind === "add-column") return renderAddColumn(plan, namespace);
		if (plan.kind === "add-index" || plan.kind === "add-unique-index") {
			return renderAddIndex(plan);
		}
		if (plan.kind === "drop-index") return renderDropIndex(plan);
		if (plan.kind === "drop-table") return renderDropTable(plan);
		if (plan.kind === "drop-column") return renderDropColumn(plan);
		if (plan.kind === "create-enum") return renderCreateEnum(plan, namespace);
		if (plan.kind === "add-enum-member") return renderAddEnumMember(plan, namespace);
		if (plan.kind === "drop-enum") return renderDropEnum(plan, namespace);
		if (plan.kind === "drop-ref") return renderDropRef(plan);
		throw new SnqlError(
			`DDL kind '${(plan as { kind: string }).kind}' non supporté par le codegen MSSQL M/6`,
			"codegen_ddl_unsupported"
		);
	},
	/**
	 * `raw "SQL"` → SqlQuery text-only, params vides (l'adapter M/1 exécute
	 * déjà). Refus explicit d'un `raw {...}` (payload document Mongo).
	 */
	mapRaw(plan: RawPlan): NativeQuery {
		if (plan.payload.kind !== "sql") {
			throw new SnqlError(
				"'raw {...}' est un document Mongo — sur MSSQL utilise 'raw \"SELECT ...\"'.",
				"codegen_raw_shape_mismatch"
			);
		}
		return {
			engine: "mssql",
			kind: "sql",
			text: plan.payload.text,
			params: [],
			paramSpans: []
		};
	}
};

/**
 * SQL de `describe <table>` — miroir du describeTableSql PG : une ligne par
 * colonne avec type, nullable, default, is_primary_key, foreign_key
 * (`table.col` de la cible, première par ordre lexical sur FK multi-cible).
 * Pas d'ORDER BY dans le baseText (interdit en sous-requête T-SQL quand des
 * postOps wrappent) — l'ordre ORDINAL_POSITION est appliqué en suffix hors
 * wrap. COLUMN_DEFAULT remonte tel quel, parenthèses T-SQL incluses
 * (`((0))`) — pas de strip regex, T-SQL n'a pas de regex_replace.
 */
function describeTableSql(ns: string, target: string): string {
	return (
		`SELECT ` +
			`c.COLUMN_NAME AS name, ` +
			`c.DATA_TYPE AS type, ` +
			`CAST(CASE WHEN c.IS_NULLABLE = 'YES' THEN 1 ELSE 0 END AS bit) AS nullable, ` +
			`c.COLUMN_DEFAULT AS [default], ` +
			`CAST(CASE WHEN pk.column_name IS NOT NULL THEN 1 ELSE 0 END AS bit) AS is_primary_key, ` +
			`fk.foreign_key AS foreign_key ` +
		`FROM INFORMATION_SCHEMA.COLUMNS c ` +
		`LEFT JOIN (` +
			`SELECT kcu.COLUMN_NAME AS column_name ` +
			`FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc ` +
			`JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu ` +
				`ON kcu.CONSTRAINT_NAME = tc.CONSTRAINT_NAME ` +
				`AND kcu.TABLE_SCHEMA = tc.TABLE_SCHEMA ` +
				`AND kcu.TABLE_NAME = tc.TABLE_NAME ` +
			`WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY' ` +
				`AND tc.TABLE_SCHEMA = ${ns} AND tc.TABLE_NAME = ${target}` +
		`) pk ON pk.column_name = c.COLUMN_NAME ` +
		`LEFT JOIN (` +
			`SELECT COL_NAME(fkc.parent_object_id, fkc.parent_column_id) AS column_name, ` +
				`MIN(OBJECT_NAME(fkc.referenced_object_id) + '.' + COL_NAME(fkc.referenced_object_id, fkc.referenced_column_id)) AS foreign_key ` +
			`FROM sys.foreign_key_columns fkc ` +
			`JOIN sys.tables t ON t.object_id = fkc.parent_object_id ` +
			`WHERE SCHEMA_NAME(t.schema_id) = ${ns} AND t.name = ${target} ` +
			`GROUP BY COL_NAME(fkc.parent_object_id, fkc.parent_column_id)` +
		`) fk ON fk.column_name = c.COLUMN_NAME ` +
		`WHERE c.TABLE_SCHEMA = ${ns} AND c.TABLE_NAME = ${target}`
	);
}

/**
 * SQL de `list indexes [on <table>]` — sys.indexes porte les flags,
 * STRING_AGG WITHIN GROUP reconstruit la liste des colonnes clés dans
 * l'ordre déclaré (key_ordinal). Les heaps (index name NULL) sont exclus.
 */
function listIndexesSql(ns: string, target: string | undefined): string {
	const tableFilter = target !== undefined ? ` AND t.name = ${target}` : "";
	return (
		`SELECT ` +
			`i.name AS name, ` +
			`t.name AS [table], ` +
			`i.is_unique AS [unique], ` +
			`(SELECT STRING_AGG(COL_NAME(ic.object_id, ic.column_id), ', ') WITHIN GROUP (ORDER BY ic.key_ordinal) ` +
			`FROM sys.index_columns ic ` +
			`WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.is_included_column = 0) AS columns ` +
		`FROM sys.indexes i ` +
		`JOIN sys.tables t ON t.object_id = i.object_id ` +
		`WHERE SCHEMA_NAME(t.schema_id) = ${ns} AND i.name IS NOT NULL${tableFilter}`
	);
}

/**
 * `list enums` / `describe enum <name>` — lecture de la table metadata
 * `_snql_enums(name, members)` (members = JSON array, écrit par le DDL
 * compensé M/6). `IF OBJECT_ID(@pN)` garde : table absente → la branche
 * ELSE renvoie 0 row au MÊME shape (parité Mongo `_snql_enums` manquante →
 * 0 rows, jamais une erreur). Avec postOps, CHAQUE branche est wrappée (les
 * placeholders du wrap sont bindés par branche — valeurs dupliquées, ordre
 * positionnel correct). OPENJSON = 2016+/compat 130 (noté M/7).
 */
function renderEnumsIntrospect(
	plan: IntrospectPlan,
	namespace: string,
	params: ParamList,
	hasPostOps: boolean
): NativeQuery {
	const nsIdent = quoteIdent(namespace);
	const metaTable = `${nsIdent}.[_snql_enums]`;
	const objectRef = params.add(`${namespace}._snql_enums`);
	let mainSelect: string;
	let emptySelect: string;
	let defaultOrder: string;
	if (plan.kind === "list-enums") {
		mainSelect = `SELECT [name], (SELECT COUNT(*) FROM OPENJSON([members])) AS members_count FROM ${metaTable}`;
		emptySelect = `SELECT TOP 0 CAST(NULL AS nvarchar(4000)) AS [name], CAST(NULL AS int) AS members_count`;
		defaultOrder = "[name] ASC";
	} else {
		if (plan.target === undefined) {
			throw new SnqlError(
				"'describe enum' sans nom cible (bug parser)",
				"codegen_introspect_missing_target"
			);
		}
		const targetRef = params.add(plan.target);
		mainSelect =
			`SELECT j.value AS member, CAST(j.[key] AS int) + 1 AS position ` +
			`FROM ${metaTable} CROSS APPLY OPENJSON([members]) j ` +
			`WHERE [name] = ${targetRef}`;
		emptySelect = `SELECT TOP 0 CAST(NULL AS nvarchar(4000)) AS member, CAST(NULL AS int) AS position`;
		defaultOrder = "[position] ASC";
	}
	const mainText = hasPostOps
		? MSSQL.wrapIntrospectPostOps(
				mainSelect,
				plan.postOps ?? [],
				params,
				defaultOrder
			)
		: `${mainSelect} ORDER BY ${defaultOrder}`;
	const emptyText = hasPostOps
		? MSSQL.wrapIntrospectPostOps(emptySelect, plan.postOps ?? [], params)
		: emptySelect;
	const text = `IF OBJECT_ID(${objectRef}, N'U') IS NOT NULL ${mainText} ELSE ${emptyText}`;
	return {
		engine: "mssql",
		kind: "sql",
		text,
		params: params.all(),
		paramSpans: params.allSpans()
	};
}

function renderReadAsSqlQuery(plan: LogicalPlan): SqlQuery {
	const params = newParams();
	const text = renderPlan(plan, params);
	return {
		engine: "mssql",
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
		engine: "mssql",
		kind: "sql",
		text,
		params: params.all(),
		paramSpans: params.allSpans()
	};
}

/**
 * Codegen des mutations T-SQL. Valeurs TOUJOURS paramétrées, identifiants
 * quotés. `OUTPUT INSERTED.*`/`DELETED.*` ≈ RETURNING * — la clause se place
 * AVANT VALUES/SELECT (insert), après SET (update), après FROM cible
 * (delete). `returnRowCount === true` droppe l'OUTPUT — le driver renvoie
 * alors seulement rowCount.
 */
function renderMutation(plan: MutationPlan, params: ParamList): string {
	switch (plan.op) {
		case "insert": {
			// Upsert : route MERGE dédiée (ON CONFLICT n'existe pas en T-SQL).
			if (plan.onConflict !== undefined) {
				return renderMergeUpsert(plan, params);
			}
			const cols = plan.columns.map(quoteIdent).join(", ");
			const output = plan.returnRowCount === true ? "" : " OUTPUT INSERTED.*";
			if (plan.sourcePlan !== undefined) {
				const selectText = renderPlan(plan.sourcePlan, params);
				return `INSERT INTO ${quoteIdent(plan.collection)} (${cols})${output} ${selectText}`;
			}
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
			return `INSERT INTO ${quoteIdent(plan.collection)} (${cols})${output} VALUES ${rows}`;
		}
		case "update": {
			const set = plan.assignments
				.map((a) => `${quoteIdent(a.column)} = ${renderExpr(a.value, params)}`)
				.join(", ");
			const joins = plan.joins ?? [];
			const output = plan.returnRowCount === true ? "" : " OUTPUT INSERTED.*";
			// T-SQL mutation join : `UPDATE <alias> SET … FROM [t] AS <alias>,
			// [x] AS b WHERE …` — la cible DOIT référencer l'alias déclaré dans
			// le FROM (forme old-style alignée sur l'UPDATE…FROM PG).
			if (plan.alias !== undefined || joins.length > 0) {
				const targetAlias = plan.alias ?? plan.collection;
				const fromSources = [
					plan.alias !== undefined
						? `${quoteIdent(plan.collection)} AS ${quoteIdent(plan.alias)}`
						: quoteIdent(plan.collection),
					...joins.map(
						(j) => `${quoteIdent(j.collection)} AS ${quoteIdent(j.as)}`
					)
				];
				const joinPreds = joins.map(
					(j) =>
						`${renderJoinPath(j.localField, targetAlias)} = ${renderJoinPath(j.foreignField, j.as)}`
				);
				const userPred =
					plan.predicate !== undefined ? renderExpr(plan.predicate, params) : "";
				const allPreds = [...joinPreds, ...(userPred !== "" ? [userPred] : [])];
				const where = allPreds.length > 0 ? ` WHERE ${allPreds.join(" AND ")}` : "";
				return `UPDATE ${quoteIdent(targetAlias)} SET ${set}${output} FROM ${fromSources.join(", ")}${where}`;
			}
			const where = renderWhere(plan.predicate, params);
			return `UPDATE ${quoteIdent(plan.collection)} SET ${set}${output}${where}`;
		}
		case "delete": {
			const output = plan.returnRowCount === true ? "" : " OUTPUT DELETED.*";
			const where = renderWhere(plan.predicate, params);
			return `DELETE FROM ${quoteIdent(plan.collection)}${output}${where}`;
		}
	}
}

/**
 * Upsert `add {…} into t on conflict (keys) [ignore | edit set …]` → MERGE.
 *
 *   MERGE INTO [t] WITH (HOLDLOCK) AS [__sqlnest_t]
 *   USING (VALUES (@p…), …) AS [__sqlnest_s] ([cols])
 *   ON [__sqlnest_t].[k] = [__sqlnest_s].[k] [AND …]
 *   [WHEN MATCHED [AND (pred)] THEN UPDATE SET [c] = expr, …]
 *   WHEN NOT MATCHED THEN INSERT ([cols]) VALUES ([__sqlnest_s].[c], …)
 *   [OUTPUT INSERTED.*];
 *
 * WITH (HOLDLOCK) : sans l'hint, deux MERGE concurrents sur la même clé
 * peuvent tous deux prendre la branche INSERT (violation unique) — l'hint
 * rétablit la garantie atomique d'ON CONFLICT PG. Le `;` terminal est
 * OBLIGATOIRE (T-SQL exige la terminaison du MERGE). `ignore` = pas de
 * WHEN MATCHED → la row en conflit ne produit ni action ni OUTPUT (parité
 * DO NOTHING + RETURNING qui skip). Dans le pred/assignments du edit, les
 * refs de colonnes nues sont qualifiées [__sqlnest_t] (l'ambiguïté
 * target/source est une ERREUR T-SQL, contrairement à PG où la ref nue
 * résout sur la table) ; `new.<col>` → [__sqlnest_s] via le dialecte.
 */
function renderMergeUpsert(
	plan: Extract<MutationPlan, { op: "insert" }>,
	params: ParamList
): string {
	const clause = plan.onConflict;
	if (clause === undefined) {
		throw new SnqlError(
			"renderMergeUpsert sans onConflict (bug appelant)",
			"codegen_mssql_merge_no_conflict"
		);
	}
	if (plan.sourcePlan !== undefined) {
		// PG a la même limite (ON CONFLICT + INSERT SELECT est possible côté
		// PG mais le lower SNQL ne produit pas cette combinaison aujourd'hui).
		throw new SnqlError(
			"upsert + insert-select non supporté (le lower ne produit pas cette forme)",
			"codegen_mssql_merge_insert_select"
		);
	}
	const target = quoteIdent(MERGE_TARGET);
	const source = quoteIdent(MERGE_SOURCE);
	const cols = plan.columns.map(quoteIdent);
	const valuesRows = plan.rows
		.map(
			(row, rowIdx) =>
				`(${row
					.map((value, colIdx) =>
						renderValue(value, params, plan.cellSpans?.[rowIdx]?.[colIdx])
					)
					.join(", ")})`
		)
		.join(", ");
	const onPreds = clause.keys
		.map((k) => `${target}.${quoteIdent(k)} = ${source}.${quoteIdent(k)}`)
		.join(" AND ");

	const parts: string[] = [
		`MERGE INTO ${quoteIdent(plan.collection)} WITH (HOLDLOCK) AS ${target}`,
		`USING (VALUES ${valuesRows}) AS ${source} (${cols.join(", ")})`,
		`ON ${onPreds}`
	];
	if (clause.action.kind === "update") {
		const set = clause.action.assignments
			.map(
				(a) =>
					`${quoteIdent(a.column)} = ${renderExpr(qualifyForMerge(a.value), params)}`
			)
			.join(", ");
		const matchedCond = clause.action.where !== undefined
			? ` AND (${renderExpr(qualifyForMerge(clause.action.where), params)})`
			: "";
		parts.push(`WHEN MATCHED${matchedCond} THEN UPDATE SET ${set}`);
	}
	parts.push(
		`WHEN NOT MATCHED THEN INSERT (${cols.join(", ")}) VALUES (${cols.map((c) => `${source}.${c}`).join(", ")})`
	);
	if (plan.returnRowCount !== true) {
		parts.push("OUTPUT INSERTED.*");
	}
	return `${parts.join(" ")};`;
}

/**
 * Qualifie les refs de colonnes NUES d'un PlanExpr avec l'alias target du
 * MERGE. En T-SQL, une colonne présente dans le target ET la source (le cas
 * courant : les clés du conflit) est AMBIGUË dans WHEN MATCHED — PG résout
 * la ref nue sur la table, on reproduit cette sémantique en qualifiant.
 * `upsertNew` reste intact (le dialecte le rend [__sqlnest_s]). Les
 * subqueries/exists ne sont pas traversées (miroir PG : leurs refs vivent
 * dans leur propre scope de FROM).
 */
function qualifyForMerge(expr: PlanExpr): PlanExpr {
	switch (expr.kind) {
		case "field":
			return expr.path[0] === MERGE_TARGET || expr.path[0] === MERGE_SOURCE
				? expr
				: { ...expr, path: [MERGE_TARGET, ...expr.path] };
		case "compare":
		case "arith":
			return {
				...expr,
				left: qualifyForMerge(expr.left),
				right: qualifyForMerge(expr.right)
			};
		case "and":
		case "or":
			return {
				...expr,
				left: qualifyForMerge(expr.left),
				right: qualifyForMerge(expr.right)
			};
		case "not":
			return { ...expr, operand: qualifyForMerge(expr.operand) };
		case "isNull":
			return { ...expr, operand: qualifyForMerge(expr.operand) };
		case "cast":
			return { ...expr, operand: qualifyForMerge(expr.operand) };
		case "in":
			return {
				...expr,
				target: qualifyForMerge(expr.target),
				values: expr.values.map(qualifyForMerge)
			};
		case "call":
			return { ...expr, args: expr.args.map(qualifyForMerge) };
		case "case":
			return {
				...expr,
				branches: expr.branches.map((b) => ({
					cond: qualifyForMerge(b.cond),
					value: qualifyForMerge(b.value)
				})),
				elseValue: qualifyForMerge(expr.elseValue)
			};
		case "object":
			return {
				...expr,
				entries: expr.entries.map((e) => ({
					...e,
					value: qualifyForMerge(e.value)
				}))
			};
		case "array":
			return { ...expr, items: expr.items.map(qualifyForMerge) };
		default:
			// literal / upsertNew / subquery / exists / windowCall : intacts.
			return expr;
	}
}

/** Clause WHERE d'une mutation, ou chaîne vide si prédicat absent. */
function renderWhere(
	predicate: PlanExpr | undefined,
	params: ParamList
): string {
	return predicate === undefined
		? ""
		: ` WHERE ${renderExpr(predicate, params)}`;
}

/** Valeur littérale d'un INSERT : NULL en clair, le reste paramétré (les
 *  jsonLiteral passent par renderExpr → JSON_OBJECT/JSON_ARRAY). */
function renderValue(
	value: PlanRowValue,
	params: ParamList,
	span?: Span
): string {
	if (value.kind === "scalar") {
		return value.value === null ? "NULL" : params.add(value.value, span);
	}
	return renderExpr(value.expr, params);
}

// ─── DDL Tier-2 (M/6) ───────────────────────────────────────────────────

/**
 * Mapping SnqlType canonique → type T-SQL pour DDL. Choix figés (miroir des
 * décisions PG_DDL_TYPE, adaptés aux contraintes T-SQL) :
 *  - `string → nvarchar(max)` SAUF en position clé (PK/UNIQUE) ou enum →
 *    `nvarchar(450)` : nvarchar(max) est invalide comme colonne de clé
 *    d'index (900 bytes max → 450 chars), PG text n'a pas cette limite.
 *  - `decimal → decimal(38, 10)` (T-SQL exige precision/scale fixes).
 *  - `date → datetimeoffset` (préserve l'instant UTC, miroir timestamptz).
 *  - `json`/`array → nvarchar(max)` (pas de type json T-SQL, porteur JSON).
 *  - `enum → nvarchar(450)` + CHECK IN sur le snapshot des members.
 */
const MSSQL_DDL_TYPE: Readonly<Record<import("../schema/model").SnqlType, string>> = {
	string: "nvarchar(max)",
	int: "int",
	bigint: "bigint",
	float: "float",
	decimal: "decimal(38, 10)",
	bool: "bit",
	date: "datetimeoffset",
	json: "nvarchar(max)",
	array: "nvarchar(max)",
	uuid: "uniqueidentifier",
	enum: "nvarchar(450)",
	unknown: "nvarchar(max)"
};

const KEYABLE_STRING_TYPE = "nvarchar(450)";

/** Type SQL d'un field — string en position clé rétrogradé nvarchar(450). */
function mssqlFieldTypeSql(
	f: import("../ir/plan").CreateTableField,
	isPrimaryKey: boolean
): string {
	if (f.type === "string" && (isPrimaryKey || f.unique)) {
		return KEYABLE_STRING_TYPE;
	}
	return MSSQL_DDL_TYPE[f.type];
}

/**
 * Littéral T-SQL inline pour un default DDL — T-SQL refuse un paramètre
 * dans une contrainte DEFAULT (même famille que le 08P01 PG, pattern
 * pg-ddl-inline-defaults). Escape : doubling des quotes, préfixe N
 * (unicode) ; PAS d'escape backslash (T-SQL ne le traite pas).
 */
function mssqlInlineDefault(value: import("../ir/plan").DdlDefault): string {
	if (value === null) return "NULL";
	if (typeof value === "string") return `N'${value.replace(/'/g, "''")}'`;
	if (typeof value === "number") return String(value);
	if (typeof value === "bigint") return `CAST(${value.toString()} AS bigint)`;
	if (typeof value === "boolean") return value ? "1" : "0";
	if (isSqlDecimal(value)) return value.raw;
	if (isSqlJsonLiteral(value)) return `N'${value.raw.replace(/'/g, "''")}'`;
	throw new SnqlError(
		`Type de default DDL non supporté par mssqlInlineDefault : ${typeof value}`,
		"codegen_ddl_default_unsupported"
	);
}

/** Littéral string T-SQL escapé (membres d'enum dans les CHECK IN). */
function nstr(value: string): string {
	return `N'${value.replace(/'/g, "''")}'`;
}

/** Clause FK column-level (ADR-031) — `restrict` → NO ACTION : T-SQL n'a
 *  pas RESTRICT et, sans contraintes deferred, NO ACTION lui est
 *  fonctionnellement équivalent. */
const MSSQL_REF_ACTION: Readonly<
	Record<import("../schema/model").OnDeleteRule, string>
> = {
	restrict: "NO ACTION",
	cascade: "CASCADE",
	"set-null": "SET NULL"
};

function mssqlRefClause(ref: import("../ir/plan").FieldRefPlan): string {
	return (
		`CONSTRAINT ${quoteIdent(ref.name)} REFERENCES ` +
		`${quoteIdent(ref.targetCollection)} (${quoteIdent(ref.targetColumn)}) ` +
		`ON DELETE ${MSSQL_REF_ACTION[ref.onDelete]} ` +
		`ON UPDATE ${MSSQL_REF_ACTION[ref.onUpdate]}`
	);
}

/** CHECK IN des members d'un field enum (compensation type enum). Nom de
 *  contrainte dérivé des idents validés — permet un drop ciblé futur. */
function enumCheckClause(
	table: string,
	f: import("../ir/plan").CreateTableField
): string | undefined {
	if (f.type !== "enum" || f.enumMembers === undefined || f.enumMembers.length === 0) {
		return undefined;
	}
	const checkName = quoteIdent(`ck_${table}_${f.name}_enum`);
	const members = f.enumMembers.map(nstr).join(", ");
	return `CONSTRAINT ${checkName} CHECK (${quoteIdent(f.name)} IN (${members}))`;
}

function renderFieldDef(
	f: import("../ir/plan").CreateTableField,
	table: string,
	primaryKey: readonly string[] | undefined
): string {
	const inPk = primaryKey?.includes(f.name) ?? false;
	const parts: string[] = [quoteIdent(f.name), mssqlFieldTypeSql(f, inPk)];
	if (!f.nullable) parts.push("NOT NULL");
	if (f.unique) parts.push("UNIQUE");
	if (f.defaultValue !== undefined) {
		parts.push(`DEFAULT ${mssqlInlineDefault(f.defaultValue)}`);
	}
	const check = enumCheckClause(table, f);
	if (check !== undefined) parts.push(check);
	if (f.ref !== undefined) parts.push(mssqlRefClause(f.ref));
	return parts.join(" ");
}

/** Réf objet qualifiée en littéral pour OBJECT_ID/COL_LENGTH — les noms
 *  passent par quoteIdent (IDENT_RE) AVANT d'entrer dans le littéral. */
function objectLiteral(namespace: string, name: string): string {
	return nstr(`${quoteIdent(namespace)}.${quoteIdent(name)}`);
}

function ddlQuery(text: string): SqlQuery {
	return { engine: "mssql", kind: "sql", text, params: [], paramSpans: [] };
}

/**
 * `create table` — sans `if not exists` : CREATE TABLE simple. Avec :
 * SqlTransaction 2 steps [sp_getapplock 'sqlnest_ddl:<t>' (Exclusive,
 * Transaction-scoped) → IF OBJECT_ID IS NULL CREATE] — miroir exact de
 * l'advisory lock D3 PG : deux create concurrents sont sérialisés, le
 * second voit la table et no-op proprement.
 */
function renderCreateTable(
	plan: import("../ir/plan").CreateTablePlan,
	namespace: string
): NativeQuery {
	const cols = plan.fields.map((f) =>
		renderFieldDef(f, plan.target, plan.primaryKey)
	);
	if (plan.primaryKey !== undefined && plan.primaryKey.length > 0) {
		cols.push(`PRIMARY KEY (${plan.primaryKey.map(quoteIdent).join(", ")})`);
	}
	const createText = `CREATE TABLE ${quoteIdent(plan.target)} (${cols.join(", ")})`;
	if (!plan.ifNotExists) return ddlQuery(createText);

	const guarded = `IF OBJECT_ID(${objectLiteral(namespace, plan.target)}, N'U') IS NULL ${createText}`;
	const lockParams = newParams();
	const resourceRef = lockParams.add(`sqlnest_ddl:${plan.target}`);
	const lockStep: SqlQuery = {
		engine: "mssql",
		kind: "sql",
		text: `EXEC sp_getapplock @Resource = ${resourceRef}, @LockMode = 'Exclusive', @LockOwner = 'Transaction'`,
		params: lockParams.all(),
		paramSpans: lockParams.allSpans()
	};
	const transaction: SqlTransaction = {
		engine: "mssql",
		kind: "transaction",
		steps: [
			{ kind: "statement", query: lockStep },
			{ kind: "statement", query: ddlQuery(guarded) }
		]
	};
	return transaction;
}

/**
 * `add column` → `ALTER TABLE … ADD` (T-SQL : ADD, jamais ADD COLUMN).
 * D10 backfill : NOT NULL + DEFAULT backfille nativement ; nullable +
 * DEFAULT exige `WITH VALUES` pour peupler les rows existantes (parité
 * PG qui backfille toujours). `if not exists` → guard COL_LENGTH.
 */
function renderAddColumn(
	plan: import("../ir/plan").AddColumnPlan,
	namespace: string
): NativeQuery {
	const f = plan.column;
	const def = renderFieldDef(f, plan.target, undefined);
	const withValues =
		f.defaultValue !== undefined && f.nullable ? " WITH VALUES" : "";
	const alterText = `ALTER TABLE ${quoteIdent(plan.target)} ADD ${def}${withValues}`;
	if (!plan.ifNotExists) return ddlQuery(alterText);
	const table = nstr(`${quoteIdent(namespace)}.${quoteIdent(plan.target)}`);
	return ddlQuery(
		`IF COL_LENGTH(${table}, ${nstr(f.name)}) IS NULL ${alterText}`
	);
}

/** `add [unique] index` → `CREATE [UNIQUE] INDEX … ON …`. Pas d'ONLINE=ON
 *  (Enterprise-only — un Standard refuserait) : lock court assumé, miroir
 *  du choix CONCURRENTLY documenté côté PG. */
function renderAddIndex(
	plan: import("../ir/plan").AddIndexPlan
): NativeQuery {
	const unique = plan.kind === "add-unique-index" ? "UNIQUE " : "";
	const cols = plan.fields.map(quoteIdent).join(", ");
	const createText = `CREATE ${unique}INDEX ${quoteIdent(plan.name)} ON ${quoteIdent(plan.target)} (${cols})`;
	if (!plan.ifNotExists) return ddlQuery(createText);
	return ddlQuery(
		`IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = ${nstr(plan.name)} AND object_id = OBJECT_ID(${nstr(quoteIdent(plan.target))})) ${createText}`
	);
}

/** `drop index NAME from T` → `DROP INDEX [IF EXISTS] [n] ON [t]` — T-SQL
 *  exige la table (l'index est table-scoped, pas schema-scoped comme PG). */
function renderDropIndex(
	plan: import("../ir/plan").DropIndexPlan
): NativeQuery {
	const ifExists = plan.ifExists ? "IF EXISTS " : "";
	return ddlQuery(
		`DROP INDEX ${ifExists}${quoteIdent(plan.name)} ON ${quoteIdent(plan.target)}`
	);
}

/** `drop table` → `DROP TABLE [IF EXISTS]` — le refus si FK dépendantes est
 *  natif T-SQL (comportement par défaut, pas de mot-clé RESTRICT). */
function renderDropTable(
	plan: import("../ir/plan").DropTablePlan
): NativeQuery {
	const ifExists = plan.ifExists ? "IF EXISTS " : "";
	return ddlQuery(`DROP TABLE ${ifExists}${quoteIdent(plan.target)}`);
}

/** `drop column` → `ALTER TABLE … DROP COLUMN [IF EXISTS]` (natif 2016+).
 *  Refus natif si contrainte/index dépendant (défaut T-SQL ≡ RESTRICT). */
function renderDropColumn(
	plan: import("../ir/plan").DropColumnPlan
): NativeQuery {
	const ifExists = plan.ifExists ? "IF EXISTS " : "";
	return ddlQuery(
		`ALTER TABLE ${quoteIdent(plan.target)} DROP COLUMN ${ifExists}${quoteIdent(plan.column)}`
	);
}

/** `drop ref` → `ALTER TABLE … DROP CONSTRAINT [IF EXISTS]` — natif, miroir
 *  PG exact (D7 typing gate côté frontend). */
function renderDropRef(plan: import("../ir/plan").DropRefPlan): NativeQuery {
	const ifExists = plan.ifExists ? "IF EXISTS " : "";
	return ddlQuery(
		`ALTER TABLE ${quoteIdent(plan.target)} DROP CONSTRAINT ${ifExists}${quoteIdent(plan.name)}`
	);
}

/** Nom qualifié de la table metadata enums + DDL de bootstrap (créée au
 *  premier `create enum` — M/5 sait déjà la lire, shape figé). */
function enumsMetaTable(namespace: string): string {
	return `${quoteIdent(namespace)}.[_snql_enums]`;
}

function ensureEnumsTableSql(namespace: string): string {
	return (
		`IF OBJECT_ID(${nstr(`${quoteIdent(namespace)}.[_snql_enums]`)}, N'U') IS NULL ` +
		`CREATE TABLE ${enumsMetaTable(namespace)} ([name] nvarchar(128) NOT NULL PRIMARY KEY, [members] nvarchar(max) NOT NULL)`
	);
}

/**
 * `create enum` — compensation : bootstrap `_snql_enums` + INSERT (name,
 * members JSON array). Les statements du batch mixent DDL guardé et DML
 * paramétré (@pN valides sur l'INSERT — seul le DDL pur refuse les
 * params). `if not exists` → INSERT guardé NOT EXISTS (sinon la violation
 * PK remonte en erreur duplicate propre, miroir 42710 PG).
 */
function renderCreateEnum(
	plan: import("../ir/plan").CreateEnumPlan,
	namespace: string
): NativeQuery {
	const params = newParams();
	const nameRef = params.add(plan.name);
	const membersRef = params.add(JSON.stringify(plan.members));
	const meta = enumsMetaTable(namespace);
	const insert = `INSERT INTO ${meta} ([name], [members]) VALUES (${nameRef}, ${membersRef})`;
	const guardedInsert = plan.ifNotExists
		? `IF NOT EXISTS (SELECT 1 FROM ${meta} WHERE [name] = ${nameRef}) ${insert}`
		: insert;
	return {
		engine: "mssql",
		kind: "sql",
		text: `${ensureEnumsTableSql(namespace)}; ${guardedInsert}`,
		params: params.all(),
		paramSpans: params.allSpans()
	};
}

/**
 * `add enum member` — `JSON_MODIFY(members, 'append $', @p)` avec dedup
 * NOT EXISTS sur OPENJSON (déjà présent → 0 row affected, silence D3
 * miroir `ADD VALUE IF NOT EXISTS` PG). Enum inconnu → 0 row affected
 * silencieux (divergence assumée vs l'erreur PG — même comportement que
 * l'`$addToSet` Mongo sur _id absent, documenté).
 */
function renderAddEnumMember(
	plan: import("../ir/plan").AddEnumMemberPlan,
	namespace: string
): NativeQuery {
	const params = newParams();
	const nameRef = params.add(plan.name);
	const memberRef = params.add(plan.member);
	const meta = enumsMetaTable(namespace);
	const text =
		`UPDATE ${meta} SET [members] = JSON_MODIFY([members], 'append $', ${memberRef}) ` +
		`WHERE [name] = ${nameRef} ` +
		`AND NOT EXISTS (SELECT 1 FROM OPENJSON([members]) WHERE [value] = ${memberRef})`;
	return {
		engine: "mssql",
		kind: "sql",
		text,
		params: params.all(),
		paramSpans: params.allSpans()
	};
}

/**
 * `drop enum` — DELETE de la ligne metadata. Les CHECK IN des colonnes
 * utilisatrices restent en place (le lien colonne↔enum n'est pas traçable
 * en T-SQL V1 — le CHECK porte les members inline, pas le nom) : RESTRICT
 * D8 non vérifiable côté engine, divergence documentée vs le 2BP01 PG.
 * `if exists` et absent → 0 row affected, silence naturel.
 */
function renderDropEnum(
	plan: import("../ir/plan").DropEnumPlan,
	namespace: string
): NativeQuery {
	const params = newParams();
	const nameRef = params.add(plan.name);
	const meta = enumsMetaTable(namespace);
	const text = `IF OBJECT_ID(${nstr(`${quoteIdent(namespace)}.[_snql_enums]`)}, N'U') IS NOT NULL DELETE FROM ${meta} WHERE [name] = ${nameRef}`;
	return {
		engine: "mssql",
		kind: "sql",
		text,
		params: params.all(),
		paramSpans: params.allSpans()
	};
}
