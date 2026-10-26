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
import { isDdlDefaultFn, isSqlDecimal, isSqlJsonLiteral } from "../ir/plan";
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
			return renderAddIndex(plan, namespace);
		}
		if (plan.kind === "drop-index") return renderDropIndex(plan, namespace);
		if (plan.kind === "drop-table") return renderDropTable(plan, namespace);
		if (plan.kind === "drop-column") return renderDropColumn(plan, namespace);
		if (plan.kind === "create-enum") return renderCreateEnum(plan, namespace);
		if (plan.kind === "add-enum-member") return renderAddEnumMember(plan, namespace);
		if (plan.kind === "drop-enum") return renderDropEnum(plan, namespace);
		if (plan.kind === "drop-ref") return renderDropRef(plan, namespace);
		if (plan.kind === "add-ref") return renderAddRef(plan, namespace);
		if (plan.kind === "rename-column") return renderRenameColumn(plan, namespace);
		if (plan.kind === "alter-column") {
			return plan.action.kind === "set-default" || plan.action.kind === "drop-default"
				? renderColumnDefault(plan, namespace)
				: renderAlterColumn(plan, namespace);
		}
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
 * SQL de `list indexes [on <table>]` — sys.indexes porte les flags. La
 * liste des colonnes clés est reconstruite via STUFF + FOR XML PATH dans
 * l'ordre key_ordinal : forme universelle 2005+ (STRING_AGG = 2017+, passe
 * 2014 M/7), identique en sortie — les noms de colonnes sont des idents,
 * aucun caractère à échapper côté XML. Les heaps (name NULL) sont exclus.
 */
function listIndexesSql(ns: string, target: string | undefined): string {
	const tableFilter = target !== undefined ? ` AND t.name = ${target}` : "";
	return (
		`SELECT ` +
			`i.name AS name, ` +
			`t.name AS [table], ` +
			`i.is_unique AS [unique], ` +
			`STUFF((SELECT ', ' + COL_NAME(ic.object_id, ic.column_id) ` +
			`FROM sys.index_columns ic ` +
			`WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.is_included_column = 0 ` +
			`ORDER BY ic.key_ordinal FOR XML PATH('')), 1, 2, '') AS columns ` +
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
		// Count par virgules — universel 2005+ (OPENJSON exige compat ≥ 130,
		// passe 2014 M/7). Sûr par construction : les members sont des idents
		// validés au lower (jamais de virgule/quote dans les valeurs).
		mainSelect = `SELECT [name], CASE WHEN [members] = '[]' THEN 0 ELSE (LEN([members]) - LEN(REPLACE([members], ',', ''))) + 1 END AS members_count FROM ${metaTable}`;
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
		// Split XML universel 2005+ (pas d'OPENJSON) : '["a","b"]' → strip
		// [ ] " (idents validés = jamais présents dans les valeurs) →
		// 'a,b' → '<m>a</m><m>b</m>' → nodes. La position = index XPath réel
		// du node (ordre du document garanti par construction).
		mainSelect =
			`SELECT m.n.value('.', 'nvarchar(4000)') AS member, ` +
			`m.n.value('for $i in . return count(../*[. << $i]) + 1', 'int') AS position ` +
			`FROM ${metaTable} ` +
			`CROSS APPLY (SELECT CAST('<m>' + REPLACE(REPLACE(REPLACE(REPLACE([members], '[', ''), ']', ''), '"', ''), ',', '</m><m>') + '</m>' AS xml) AS x) AS j ` +
			`CROSS APPLY j.x.nodes('/m') AS m(n) ` +
			`WHERE [name] = ${targetRef} AND [members] <> '[]'`;
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
 *    d'index (900 bytes max → 450 chars), PG text n'a pas cette limite. Un
 *    index posé plus tard rétrécit la colonne (`renderAddIndex`).
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

const PRINTABLE_ASCII_RE = /^[\x20-\x7e]*$/;

function mssqlTextLiteral(value: string): string {
	const escaped = value.replace(/'/g, "''");
	return PRINTABLE_ASCII_RE.test(value) ? `'${escaped}'` : `N'${escaped}'`;
}

/** Taille maximale d'une clé d'index clustered, et de toute clé avant 2016. */
const MSSQL_INDEX_KEY_BYTES = 900;

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
 * pg-ddl-inline-defaults). Escape : doubling des quotes ; PAS d'escape
 * backslash (T-SQL ne le traite pas). Le défaut s'écrit comme l'écrirait un
 * ORM, qui le relit ensuite comme une valeur : texte ASCII sans préfixe `N`
 * (Prisma relit `(N'x')` comme la chaîne `N'x'`), `N'…'` au-delà pour garder
 * l'unicode ; bigint sans `CAST`.
 */
function mssqlInlineDefault(value: import("../ir/plan").DdlDefault): string {
	if (value === null) return "NULL";
	if (typeof value === "string") return mssqlTextLiteral(value);
	if (typeof value === "number") return String(value);
	if (typeof value === "bigint") return value.toString();
	if (typeof value === "boolean") return value ? "1" : "0";
	if (isSqlDecimal(value)) return value.raw;
	if (isSqlJsonLiteral(value)) return mssqlTextLiteral(value.raw);
	// `date` est un datetimeoffset côté MSSQL : SYSDATETIMEOFFSET, pas SYSUTCDATETIME.
	if (isDdlDefaultFn(value)) {
		return value.fn === "now" ? "SYSDATETIMEOFFSET()" : "NEWID()";
	}
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

function mssqlRefClause(
	ref: import("../ir/plan").FieldRefPlan,
	namespace: string
): string {
	return (
		`CONSTRAINT ${quoteIdent(ref.name)} REFERENCES ` +
		`${qualified(namespace, ref.targetCollection)} (${quoteIdent(ref.targetColumn)}) ` +
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

/** `[schéma].[table]` : le DDL vise le schéma de la connexion (`?schema=`). */
function qualified(namespace: string, table: string): string {
	return `${quoteIdent(namespace)}.${quoteIdent(table)}`;
}

/** `CONSTRAINT [n] ` quand un profil ORM impose le nom (ADR-036 D6), sinon
 *  le moteur nomme. */
function constraintPrefix(name: string | undefined): string {
	return name !== undefined ? `CONSTRAINT ${quoteIdent(name)} ` : "";
}

function renderFieldDef(
	f: import("../ir/plan").CreateTableField,
	table: string,
	primaryKey: readonly string[] | undefined,
	namespace: string
): string {
	const inPk = primaryKey?.includes(f.name) ?? false;
	const parts: string[] = [quoteIdent(f.name), mssqlFieldTypeSql(f, inPk)];
	if (!f.nullable) parts.push("NOT NULL");
	if (f.unique) parts.push(`${constraintPrefix(f.uniqueName)}UNIQUE`);
	if (f.defaultValue !== undefined) {
		parts.push(
			`${constraintPrefix(f.defaultName)}DEFAULT ${mssqlInlineDefault(f.defaultValue)}`
		);
	}
	const check = enumCheckClause(table, f);
	if (check !== undefined) parts.push(check);
	if (f.ref !== undefined) parts.push(mssqlRefClause(f.ref, namespace));
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
		renderFieldDef(f, plan.target, plan.primaryKey, namespace)
	);
	if (plan.primaryKey !== undefined && plan.primaryKey.length > 0) {
		cols.push(
			`${constraintPrefix(plan.primaryKeyName)}PRIMARY KEY (${plan.primaryKey.map(quoteIdent).join(", ")})`
		);
	}
	const createText = `CREATE TABLE ${qualified(namespace, plan.target)} (${cols.join(", ")})`;
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
	const def = renderFieldDef(f, plan.target, undefined, namespace);
	const withValues =
		f.defaultValue !== undefined && f.nullable ? " WITH VALUES" : "";
	const alterText = `ALTER TABLE ${qualified(namespace, plan.target)} ADD ${def}${withValues}`;
	if (!plan.ifNotExists) return ddlQuery(alterText);
	const table = nstr(`${quoteIdent(namespace)}.${quoteIdent(plan.target)}`);
	return ddlQuery(
		`IF COL_LENGTH(${table}, ${nstr(f.name)}) IS NULL ${alterText}`
	);
}

/**
 * `add [unique] index` → `CREATE [UNIQUE] INDEX … ON …`. Pas d'ONLINE=ON
 * (Enterprise-only — un Standard refuserait) : lock court assumé, miroir du
 * choix CONCURRENTLY documenté côté PG.
 *
 * T-SQL refuse un type `(max)` comme colonne de clé d'index (1919), or un
 * texte créé hors position de clé est en `nvarchar(max)` ; de même pour les
 * types dépréciés `text`, `ntext` et `image`. Dans la même transaction
 * (ADR-029 D14), une telle colonne passe au plus large type indexable,
 * 900 octets (`nvarchar(450)`, `varchar(900)`, `varbinary(900)`), en gardant
 * nullabilité et collation, ses dépendants retirés puis recréés (D9
 * d'ADR-036). Une valeur plus longue est d'abord refusée, avec le nombre
 * de lignes : mesurée en octets, car le rétrécissement rognerait sans erreur
 * les espaces finaux que `LEN` ignore.
 */
function renderAddIndex(
	plan: import("../ir/plan").AddIndexPlan,
	namespace: string
): NativeQuery {
	const table = `${quoteIdent(namespace)}.${quoteIdent(plan.target)}`;
	const unique = plan.kind === "add-unique-index" ? "UNIQUE " : "";
	const cols = plan.fields.map(quoteIdent).join(", ");
	const lines = [
		"SET NOCOUNT ON;",
		"SET XACT_ABORT ON;",
		`DECLARE @obj int = OBJECT_ID(${nstr(table)});`,
		...(plan.ifNotExists
			? [
					`IF EXISTS (SELECT 1 FROM sys.indexes WHERE name = ${nstr(plan.name)} AND object_id = @obj) RETURN;`
				]
			: []),
		"BEGIN TRAN;",
		MSSQL_ALTER_TARGETS,
		`INSERT @targets SELECT c.object_id, c.column_id, N'ALTER TABLE ' + ${mssqlQualified("c.object_id")} + N' ALTER COLUMN ' + QUOTENAME(c.name) + CASE WHEN ty.name IN (N'nvarchar', N'ntext') THEN N' ${KEYABLE_STRING_TYPE}' WHEN ty.name IN (N'varchar', N'text') THEN N' varchar(${MSSQL_INDEX_KEY_BYTES})' ELSE N' varbinary(${MSSQL_INDEX_KEY_BYTES})' END + ISNULL(N' COLLATE ' + c.collation_name, N'') + CASE WHEN c.is_nullable = 1 THEN N' NULL' ELSE N' NOT NULL' END
FROM sys.columns c JOIN sys.types ty ON ty.user_type_id = c.user_type_id
WHERE c.object_id = @obj AND (ty.name IN (N'ntext', N'text', N'image') OR (c.max_length = -1 AND ty.name IN (N'nvarchar', N'varchar', N'varbinary'))) AND c.name IN (${plan.fields.map(nstr).join(", ")});`,
		"DECLARE @long int, @type sysname, @msg nvarchar(2048);",
		...plan.fields.map((field) => indexKeyPreflight(plan.target, table, field)),
		...mssqlAlterTargets(),
		`CREATE ${unique}INDEX ${quoteIdent(plan.name)} ON ${table} (${cols});`,
		"COMMIT;"
	];
	return ddlQuery(lines.join("\n"));
}

/**
 * Refus d'un `add index` dont la colonne à rétrécir porte des valeurs de plus
 * de 900 octets : leur nombre, et pour un `nvarchar` la commande qui les
 * retrouve (`length` compte les espaces finaux, comme `DATALENGTH`, mais
 * refuse `ntext`).
 */
function indexKeyPreflight(
	target: string,
	table: string,
	field: string
): string {
	const find = `find ${target} where length(${field}) > ${MSSQL_INDEX_KEY_BYTES / 2}`;
	return `IF EXISTS (SELECT 1 FROM @targets WHERE col = COLUMNPROPERTY(@obj, ${nstr(field)}, 'ColumnId'))
BEGIN
	SELECT @long = COUNT(*) FROM ${table} WHERE DATALENGTH(${quoteIdent(field)}) > ${MSSQL_INDEX_KEY_BYTES};
	IF @long > 0
	BEGIN
		SELECT @type = TYPE_NAME(c.system_type_id) FROM sys.columns c WHERE c.object_id = @obj AND c.name = ${nstr(field)};
		SET @msg = CONCAT(${nstr(`'${field}' dépasse `)}, CASE WHEN @type IN (N'nvarchar', N'ntext') THEN N'${MSSQL_INDEX_KEY_BYTES / 2} caractères' ELSE N'${MSSQL_INDEX_KEY_BYTES} octets' END, N' sur ', @long, CASE WHEN @long > 1 THEN N' lignes' ELSE N' ligne' END, ${nstr(` de '${target}', la limite d'une clé d'index MSSQL — à raccourcir avant l'index`)}, CASE WHEN @type = N'nvarchar' THEN ${nstr(` : ${find}`)} ELSE N'' END);
		THROW 50000, @msg, 1;
	END
END`;
}

/** `drop index NAME from T` → `DROP INDEX [n] ON [t]` — T-SQL exige la
 *  table (l'index est table-scoped, pas schema-scoped comme PG). Le
 *  `IF EXISTS` natif est 2016+ : idempotence via guard sys.indexes,
 *  universel 2005+ (passe 2014 M/7). */
function renderDropIndex(
	plan: import("../ir/plan").DropIndexPlan,
	namespace: string
): NativeQuery {
	const table = qualified(namespace, plan.target);
	const dropText = `DROP INDEX ${quoteIdent(plan.name)} ON ${table}`;
	if (!plan.ifExists) return ddlQuery(dropText);
	return ddlQuery(
		`IF EXISTS (SELECT 1 FROM sys.indexes WHERE name = ${nstr(plan.name)} AND object_id = OBJECT_ID(${nstr(table)})) ${dropText}`
	);
}

/** `drop table` — le refus si FK dépendantes est natif T-SQL (défaut ≡
 *  RESTRICT). `IF EXISTS` natif = 2016+ → guard OBJECT_ID universel. */
function renderDropTable(
	plan: import("../ir/plan").DropTablePlan,
	namespace: string
): NativeQuery {
	const dropText = `DROP TABLE ${qualified(namespace, plan.target)}`;
	if (!plan.ifExists) return ddlQuery(dropText);
	return ddlQuery(
		`IF OBJECT_ID(${objectLiteral(namespace, plan.target)}, N'U') IS NOT NULL ${dropText}`
	);
}

/**
 * `drop column` : T-SQL refuse de retirer une colonne dont dépend un index,
 * une contrainte (PK, UNIQUE, CHECK, DEFAULT), une FK qu'elle porte ou une
 * statistique créée à la main ; PG les retire avec elle. Ils sont retirés
 * d'abord, relus au catalogue à l'exécution. Une FK d'une autre table qui la
 * référence fait échouer, comme sous PG.
 */
function renderDropColumn(
	plan: import("../ir/plan").DropColumnPlan,
	namespace: string
): NativeQuery {
	const table = `${quoteIdent(namespace)}.${quoteIdent(plan.target)}`;
	const dropColumn = `ALTER TABLE ${table} DROP COLUMN ${quoteIdent(plan.column)}`;
	const dependents = [
		"DECLARE @drop nvarchar(max) = N'';",
		`SELECT @drop = @drop + N'ALTER TABLE ${table} DROP CONSTRAINT ' + QUOTENAME(fk.name) + N';'
FROM sys.foreign_keys fk
WHERE fk.parent_object_id = @obj AND EXISTS (SELECT 1 FROM sys.foreign_key_columns fkc WHERE fkc.constraint_object_id = fk.object_id AND fkc.parent_column_id = @col);`,
		`SELECT @drop = @drop + CASE WHEN i.is_primary_key = 1 OR i.is_unique_constraint = 1 THEN N'ALTER TABLE ${table} DROP CONSTRAINT ' + QUOTENAME(i.name) ELSE N'DROP INDEX ' + QUOTENAME(i.name) + N' ON ${table}' END + N';'
FROM sys.indexes i
WHERE i.object_id = @obj AND i.type IN (1, 2) AND EXISTS (SELECT 1 FROM sys.index_columns ic WHERE ic.object_id = @obj AND ic.index_id = i.index_id AND ic.column_id = @col);`,
		`SELECT @drop = @drop + N'ALTER TABLE ${table} DROP CONSTRAINT ' + QUOTENAME(cc.name) + N';'
FROM sys.check_constraints cc
WHERE cc.parent_object_id = @obj AND (cc.parent_column_id = @col OR cc.definition LIKE N'%[[]' + COL_NAME(@obj, @col) + N']%');`,
		`SELECT @drop = @drop + N'ALTER TABLE ${table} DROP CONSTRAINT ' + QUOTENAME(dc.name) + N';'
FROM sys.default_constraints dc
WHERE dc.parent_object_id = @obj AND dc.parent_column_id = @col;`,
		`SELECT @drop = @drop + N'DROP STATISTICS ${table}.' + QUOTENAME(s.name) + N';'
FROM sys.stats s
WHERE s.object_id = @obj AND s.user_created = 1 AND EXISTS (SELECT 1 FROM sys.stats_columns sc WHERE sc.object_id = @obj AND sc.stats_id = s.stats_id AND sc.column_id = @col);`,
		"EXEC (@drop);",
		`EXEC (${nstr(dropColumn)});`
	];
	const lines = [
		"SET NOCOUNT ON;",
		"SET XACT_ABORT ON;",
		"BEGIN TRY",
		"BEGIN TRAN;",
		`DECLARE @obj int = OBJECT_ID(${nstr(table)});`,
		`DECLARE @col int = COLUMNPROPERTY(@obj, ${nstr(plan.column)}, 'ColumnId');`,
		...(plan.ifExists
			? ["IF @col IS NOT NULL", "BEGIN", ...dependents, "END"]
			: [
					`IF @col IS NULL THROW 50000, ${nstr(`colonne '${plan.target}.${plan.column}' inconnue`)}, 1;`,
					...dependents
				]),
		"COMMIT;",
		"END TRY",
		"BEGIN CATCH",
		"IF @@TRANCOUNT > 0 ROLLBACK;",
		"THROW;",
		"END CATCH"
	];
	return ddlQuery(lines.join("\n"));
}

/**
 * `rename column` → `sp_rename` : le nouveau nom passe sans crochets (ils
 * feraient partie du nom). FK et index suivent la colonne ; son CHECK d'enum
 * est reposé sous le nouveau nom. Sous un profil ORM, les noms conventionnels
 * suivent, dans la même transaction ; la contrainte de défaut seulement si
 * elle existe sous ce nom (ADR-036 D6).
 */
function renderRenameColumn(
	plan: import("../ir/plan").RenameColumnPlan,
	namespace: string
): NativeQuery {
	const schema = quoteIdent(namespace);
	const table = `${schema}.${quoteIdent(plan.target)}`;
	const renameColumn = `EXEC sp_rename ${nstr(`${table}.${quoteIdent(plan.column)}`)}, ${nstr(plan.newName)}, N'COLUMN'`;
	// T-SQL refuse de renommer une colonne que son CHECK d'enum cite : retiré,
	// puis reposé sous le nouveau nom (`ck_<t>_<c>_enum`).
	const enumMembers = plan.enumMembers ?? [];
	const renames = plan.renames ?? [];
	const lines = [
		"SET NOCOUNT ON;",
		"SET XACT_ABORT ON;",
		// Une erreur de `sp_rename` n'interrompt pas le lot : sans TRY, la
		// suite s'exécuterait et serait validée.
		"BEGIN TRY",
		"BEGIN TRAN;",
		...(enumMembers.length > 0
			? [
					`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${quoteIdent(`ck_${plan.target}_${plan.column}_enum`)};`
				]
			: []),
		`${renameColumn};`,
		// Dynamique : compilé après le renommage, sinon T-SQL refuse le lot
		// entier (colonne encore inconnue à la compilation).
		...(enumMembers.length > 0
			? [
					`EXEC sp_executesql ${nstr(`ALTER TABLE ${table} WITH CHECK ADD CONSTRAINT ${quoteIdent(`ck_${plan.target}_${plan.newName}_enum`)} CHECK (${quoteIdent(plan.newName)} IN (${enumMembers.map(nstr).join(", ")}))`)};`
				]
			: [])
	];
	for (const r of renames) {
		if (r.kind === "index") {
			lines.push(
				`EXEC sp_rename ${nstr(`${table}.${quoteIdent(r.from)}`)}, ${nstr(r.to)}, N'INDEX';`
			);
		} else if (r.kind === "foreign-key") {
			lines.push(
				`EXEC sp_rename ${nstr(`${schema}.${quoteIdent(r.from)}`)}, ${nstr(r.to)}, N'OBJECT';`
			);
		} else {
			lines.push(
				`IF EXISTS (SELECT 1 FROM sys.default_constraints WHERE name = ${nstr(r.from)} AND parent_object_id = OBJECT_ID(${nstr(table)})) EXEC sp_rename ${nstr(`${schema}.${quoteIdent(r.from)}`)}, ${nstr(r.to)}, N'OBJECT';`
			);
		}
	}
	lines.push(
		"COMMIT;",
		"END TRY",
		"BEGIN CATCH",
		"IF @@TRANCOUNT > 0 ROLLBACK;",
		"THROW;",
		"END CATCH"
	);
	return ddlQuery(lines.join("\n"));
}

/**
 * `set default` / `drop default` (ADR-036 E/1d). En T-SQL, un défaut est une
 * contrainte nommée : l'existante, quel que soit son nom, est retirée, puis la
 * nouvelle est posée sous `df_<t>_<c>`, ou le nom du profil ORM.
 */
function renderColumnDefault(
	plan: import("../ir/plan").AlterColumnPlan,
	namespace: string
): NativeQuery {
	const table = `${quoteIdent(namespace)}.${quoteIdent(plan.target)}`;
	const { action } = plan;
	const lines = [
		"SET NOCOUNT ON;",
		"SET XACT_ABORT ON;",
		"BEGIN TRAN;",
		`DECLARE @obj int = OBJECT_ID(${nstr(table)});`,
		`DECLARE @col int = COLUMNPROPERTY(@obj, ${nstr(plan.column)}, 'ColumnId');`,
		`IF @col IS NULL THROW 50000, ${nstr(`colonne '${plan.target}.${plan.column}' inconnue`)}, 1;`,
		"DECLARE @drop nvarchar(max) = N'';",
		`SELECT @drop = N'ALTER TABLE ${table} DROP CONSTRAINT ' + QUOTENAME(dc.name) FROM sys.default_constraints dc WHERE dc.parent_object_id = @obj AND dc.parent_column_id = @col;`,
		"EXEC (@drop);",
		...(action.kind === "set-default"
			? [
					`ALTER TABLE ${table} ADD CONSTRAINT ${quoteIdent(action.name ?? `df_${plan.target}_${plan.column}`)} DEFAULT ${mssqlInlineDefault(action.value)} FOR ${quoteIdent(plan.column)};`
				]
			: []),
		"COMMIT;"
	];
	return ddlQuery(lines.join("\n"));
}

/** Type T-SQL complet de la colonne `t.obj`/`t.col` (alias `c`, `ty`), relu
 *  au catalogue : longueur, précision, collation. `ALTER COLUMN` exige de le
 *  répéter. */
const MSSQL_CURRENT_TYPE = `CASE
	WHEN ty.name IN (N'varchar', N'char', N'varbinary', N'binary') THEN ty.name + N'(' + CASE WHEN c.max_length = -1 THEN N'max' ELSE CAST(c.max_length AS nvarchar(10)) END + N')'
	WHEN ty.name IN (N'nvarchar', N'nchar') THEN ty.name + N'(' + CASE WHEN c.max_length = -1 THEN N'max' ELSE CAST(c.max_length / 2 AS nvarchar(10)) END + N')'
	WHEN ty.name IN (N'decimal', N'numeric') THEN ty.name + N'(' + CAST(c.precision AS nvarchar(10)) + N', ' + CAST(c.scale AS nvarchar(10)) + N')'
	WHEN ty.name IN (N'datetime2', N'time', N'datetimeoffset') THEN ty.name + N'(' + CAST(c.scale AS nvarchar(10)) + N')'
	ELSE ty.name END + ISNULL(N' COLLATE ' + c.collation_name, N'')`;

/** Liste de colonnes d'un index ou d'une FK, agrégée sans STRING_AGG (2014). */
function mssqlColumnList(select: string): string {
	return `STUFF((${select} FOR XML PATH(''), TYPE).value('.', 'nvarchar(max)'), 1, 1, N'')`;
}

/** Nom qualifié `[schéma].[table]` d'un objet, en expression T-SQL. */
function mssqlQualified(objectId: string): string {
	return `QUOTENAME(OBJECT_SCHEMA_NAME(${objectId})) + N'.' + QUOTENAME(OBJECT_NAME(${objectId}))`;
}

/** Colonnes à modifier : objet, colonne, `ALTER TABLE … ALTER COLUMN` complet. */
const MSSQL_ALTER_TARGETS =
	"DECLARE @targets TABLE (obj int, col int, sql nvarchar(max));";

/**
 * `ALTER COLUMN` des colonnes de `@targets` (ADR-036 D9). T-SQL le refuse dès
 * qu'un index, une contrainte (PK, UNIQUE, CHECK, DEFAULT), une FK ou une
 * statistique créée à la main dépend de la colonne (5074) : les dépendants,
 * relus au catalogue à l'exécution, sont retirés, puis recréés à l'identique
 * après les `ALTER COLUMN`. Les statistiques automatiques, elles, sont
 * retirées par le moteur.
 * `droppedCheck` est retiré sans être reposé. S'exécute dans la transaction
 * de l'appelant, une fois `@targets` rempli.
 */
function mssqlAlterTargets(droppedCheck?: string): string[] {
	const onTarget = (objectId: string, columnId: string): string =>
		`EXISTS (SELECT 1 FROM @targets tg WHERE tg.obj = ${objectId} AND tg.col = ${columnId})`;
	const keyCols = (filter: string): string =>
		mssqlColumnList(
			`SELECT N',' + QUOTENAME(COL_NAME(ic.object_id, ic.column_id)) + CASE WHEN ic.is_descending_key = 1 THEN N' DESC' ELSE N'' END FROM sys.index_columns ic WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id AND ${filter} ORDER BY ic.key_ordinal, ic.index_column_id`
		);
	const fkCols = (side: "parent" | "referenced"): string =>
		mssqlColumnList(
			`SELECT N',' + QUOTENAME(COL_NAME(fkc.${side}_object_id, fkc.${side}_column_id)) FROM sys.foreign_key_columns fkc WHERE fkc.constraint_object_id = fk.object_id ORDER BY fkc.constraint_column_id`
		);
	const statCols = mssqlColumnList(
		"SELECT N',' + QUOTENAME(COL_NAME(sc.object_id, sc.column_id)) FROM sys.stats_columns sc WHERE sc.object_id = s.object_id AND sc.stats_id = s.stats_id ORDER BY sc.stats_column_id"
	);
	return [
		"DECLARE @dropFk nvarchar(max) = N'', @addFk nvarchar(max) = N'';",
		"DECLARE @dropIdx nvarchar(max) = N'', @addIdx nvarchar(max) = N'';",
		"DECLARE @dropChk nvarchar(max) = N'', @addChk nvarchar(max) = N'';",
		"DECLARE @dropDf nvarchar(max) = N'', @addDf nvarchar(max) = N'';",
		"DECLARE @dropSt nvarchar(max) = N'', @addSt nvarchar(max) = N'';",
		"DECLARE @alter nvarchar(max) = N'';",
		`SELECT @dropFk = @dropFk + N'ALTER TABLE ' + ${mssqlQualified("fk.parent_object_id")} + N' DROP CONSTRAINT ' + QUOTENAME(fk.name) + N';',
	@addFk = @addFk + N'ALTER TABLE ' + ${mssqlQualified("fk.parent_object_id")} + N' WITH CHECK ADD CONSTRAINT ' + QUOTENAME(fk.name) + N' FOREIGN KEY (' + ${fkCols("parent")} + N') REFERENCES ' + ${mssqlQualified("fk.referenced_object_id")} + N' (' + ${fkCols("referenced")} + N') ON DELETE ' + REPLACE(fk.delete_referential_action_desc, N'_', N' ') + N' ON UPDATE ' + REPLACE(fk.update_referential_action_desc, N'_', N' ') + N';'
FROM sys.foreign_keys fk
WHERE EXISTS (SELECT 1 FROM sys.foreign_key_columns fkc WHERE fkc.constraint_object_id = fk.object_id AND (${onTarget("fkc.parent_object_id", "fkc.parent_column_id")} OR ${onTarget("fkc.referenced_object_id", "fkc.referenced_column_id")}));`,
		`SELECT @dropIdx = @dropIdx + CASE WHEN i.is_primary_key = 1 OR i.is_unique_constraint = 1 THEN N'ALTER TABLE ' + ${mssqlQualified("i.object_id")} + N' DROP CONSTRAINT ' + QUOTENAME(i.name) ELSE N'DROP INDEX ' + QUOTENAME(i.name) + N' ON ' + ${mssqlQualified("i.object_id")} END + N';',
	@addIdx = @addIdx + CASE
		WHEN i.is_primary_key = 1 THEN N'ALTER TABLE ' + ${mssqlQualified("i.object_id")} + N' ADD CONSTRAINT ' + QUOTENAME(i.name) + N' PRIMARY KEY ' + i.type_desc COLLATE DATABASE_DEFAULT + N' (' + ${keyCols("ic.is_included_column = 0")} + N')'
		WHEN i.is_unique_constraint = 1 THEN N'ALTER TABLE ' + ${mssqlQualified("i.object_id")} + N' ADD CONSTRAINT ' + QUOTENAME(i.name) + N' UNIQUE ' + i.type_desc COLLATE DATABASE_DEFAULT + N' (' + ${keyCols("ic.is_included_column = 0")} + N')'
		ELSE N'CREATE ' + CASE WHEN i.is_unique = 1 THEN N'UNIQUE ' ELSE N'' END + i.type_desc COLLATE DATABASE_DEFAULT + N' INDEX ' + QUOTENAME(i.name) + N' ON ' + ${mssqlQualified("i.object_id")} + N' (' + ${keyCols("ic.is_included_column = 0")} + N')' + ISNULL(N' INCLUDE (' + ${keyCols("ic.is_included_column = 1")} + N')', N'') + ISNULL(N' WHERE ' + i.filter_definition, N'')
	END + N';'
FROM sys.indexes i
WHERE i.type IN (1, 2) AND EXISTS (SELECT 1 FROM sys.index_columns ic WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id AND ${onTarget("ic.object_id", "ic.column_id")});`,
		`SELECT @dropChk = @dropChk + N'ALTER TABLE ' + ${mssqlQualified("cc.parent_object_id")} + N' DROP CONSTRAINT ' + QUOTENAME(cc.name) + N';',
	@addChk = @addChk + CASE WHEN ${droppedCheck !== undefined ? `cc.name = ${nstr(droppedCheck)}` : "1 = 0"} THEN N'' ELSE N'ALTER TABLE ' + ${mssqlQualified("cc.parent_object_id")} + N' WITH CHECK ADD CONSTRAINT ' + QUOTENAME(cc.name) + N' CHECK ' + cc.definition + N';' END
FROM sys.check_constraints cc
WHERE EXISTS (SELECT 1 FROM @targets tg WHERE tg.obj = cc.parent_object_id AND (cc.parent_column_id = tg.col OR cc.definition LIKE N'%[[]' + COL_NAME(tg.obj, tg.col) + N']%'));`,
		`SELECT @dropDf = @dropDf + N'ALTER TABLE ' + ${mssqlQualified("dc.parent_object_id")} + N' DROP CONSTRAINT ' + QUOTENAME(dc.name) + N';',
	@addDf = @addDf + N'ALTER TABLE ' + ${mssqlQualified("dc.parent_object_id")} + N' ADD CONSTRAINT ' + QUOTENAME(dc.name) + N' DEFAULT ' + dc.definition + N' FOR ' + QUOTENAME(COL_NAME(dc.parent_object_id, dc.parent_column_id)) + N';'
FROM sys.default_constraints dc
WHERE ${onTarget("dc.parent_object_id", "dc.parent_column_id")};`,
		`SELECT @dropSt = @dropSt + N'DROP STATISTICS ' + ${mssqlQualified("s.object_id")} + N'.' + QUOTENAME(s.name) + N';',
	@addSt = @addSt + N'CREATE STATISTICS ' + QUOTENAME(s.name) + N' ON ' + ${mssqlQualified("s.object_id")} + N' (' + ${statCols} + N')' + ISNULL(N' WHERE ' + s.filter_definition, N'') + CASE WHEN s.no_recompute = 1 THEN N' WITH NORECOMPUTE' ELSE N'' END + N';'
FROM sys.stats s
WHERE s.user_created = 1 AND EXISTS (SELECT 1 FROM sys.stats_columns sc WHERE sc.object_id = s.object_id AND sc.stats_id = s.stats_id AND ${onTarget("sc.object_id", "sc.column_id")});`,
		"SELECT @alter = @alter + sql + N';' FROM @targets;",
		"EXEC (@dropFk); EXEC (@dropIdx); EXEC (@dropChk); EXEC (@dropDf); EXEC (@dropSt);",
		"EXEC (@alter);",
		"EXEC (@addSt); EXEC (@addDf); EXEC (@addChk); EXEC (@addIdx); EXEC (@addFk);"
	];
}

/**
 * `alter column` (ADR-036 E/1c), dépendants retirés puis recréés autour de
 * l'`ALTER COLUMN` (D9). Une FK exige des types identiques des deux côtés :
 * `set type` emmène les colonnes partenaires des FK de la colonne. Le CHECK
 * d'enum `ck_<t>_<c>_enum` suit le type : retiré, puis reposé si la cible
 * est un enum. Une valeur non convertible fait échouer la transaction, rien
 * n'est modifié.
 */
function renderAlterColumn(
	plan: import("../ir/plan").AlterColumnPlan,
	namespace: string
): NativeQuery {
	const table = `${quoteIdent(namespace)}.${quoteIdent(plan.target)}`;
	const column = quoteIdent(plan.column);
	const enumCheck = `ck_${plan.target}_${plan.column}_enum`;
	const { action } = plan;
	const isTypeChange = action.kind === "set-type";
	// Type cible : un texte qui reste indexé passe en nvarchar(450).
	const newType = (obj: string, col: string): string =>
		action.kind !== "set-type"
			? ""
			: action.type === "string" || action.type === "enum"
				? `CASE WHEN EXISTS (SELECT 1 FROM sys.index_columns ic WHERE ic.object_id = ${obj} AND ic.column_id = ${col}) THEN N'${KEYABLE_STRING_TYPE}' ELSE N'${MSSQL_DDL_TYPE[action.type]}' END`
				: `N'${MSSQL_DDL_TYPE[action.type]}'`;
	const nullability = (kind: string): string =>
		kind === "set-nullable"
			? "N' NULL'"
			: kind === "set-not-null"
				? "N' NOT NULL'"
				: "CASE WHEN c.is_nullable = 1 THEN N' NULL' ELSE N' NOT NULL' END";
	const enumAdd =
		action.kind === "set-type" &&
		action.type === "enum" &&
		action.enumMembers !== undefined &&
		action.enumMembers.length > 0
			? `ALTER TABLE ${table} WITH CHECK ADD CONSTRAINT ${quoteIdent(enumCheck)} CHECK (${column} IN (${action.enumMembers.map(nstr).join(", ")}));`
			: "";
	const lines = [
		// Les lectures du catalogue ne sont pas des lignes affectées.
		"SET NOCOUNT ON;",
		"SET XACT_ABORT ON;",
		"BEGIN TRAN;",
		`DECLARE @obj int = OBJECT_ID(${nstr(table)});`,
		`DECLARE @col int = COLUMNPROPERTY(@obj, ${nstr(plan.column)}, 'ColumnId');`,
		`IF @col IS NULL THROW 50000, ${nstr(`colonne '${plan.target}.${plan.column}' inconnue`)}, 1;`,
		MSSQL_ALTER_TARGETS,
		`INSERT @targets SELECT c.object_id, c.column_id, N'ALTER TABLE ' + ${mssqlQualified("c.object_id")} + N' ALTER COLUMN ' + QUOTENAME(c.name) + N' ' + ${isTypeChange ? newType("c.object_id", "c.column_id") : MSSQL_CURRENT_TYPE} + ${nullability(action.kind)}
FROM sys.columns c JOIN sys.types ty ON ty.user_type_id = c.user_type_id
WHERE (c.object_id = @obj AND c.column_id = @col)${
			isTypeChange
				? `
	OR EXISTS (SELECT 1 FROM sys.foreign_key_columns fkc WHERE (fkc.referenced_object_id = @obj AND fkc.referenced_column_id = @col AND fkc.parent_object_id = c.object_id AND fkc.parent_column_id = c.column_id) OR (fkc.parent_object_id = @obj AND fkc.parent_column_id = @col AND fkc.referenced_object_id = c.object_id AND fkc.referenced_column_id = c.column_id))`
				: ""
		};`,
		...mssqlAlterTargets(isTypeChange ? enumCheck : undefined),
		...(enumAdd !== "" ? [`EXEC (${nstr(enumAdd)});`] : []),
		"COMMIT;"
	];
	return ddlQuery(lines.join("\n"));
}

/** `add ref` → contrainte de table. `WITH CHECK` : les lignes existantes
 *  sont vérifiées (orphelins refusés) et la contrainte est approuvée. */
function renderAddRef(
	plan: import("../ir/plan").AddRefPlan,
	namespace: string
): NativeQuery {
	const { ref } = plan;
	return ddlQuery(
		`ALTER TABLE ${qualified(namespace, plan.target)} WITH CHECK ADD CONSTRAINT ${quoteIdent(ref.name)} ` +
			`FOREIGN KEY (${quoteIdent(ref.fromColumn)}) REFERENCES ` +
			`${qualified(namespace, ref.targetCollection)} (${quoteIdent(ref.targetColumn)}) ` +
			`ON DELETE ${MSSQL_REF_ACTION[ref.onDelete]} ` +
			`ON UPDATE ${MSSQL_REF_ACTION[ref.onUpdate]}`
	);
}

/** `drop ref` → `ALTER TABLE … DROP CONSTRAINT` — natif, miroir PG (D7
 *  typing gate côté frontend). `IF EXISTS` → guard OBJECT_ID(…, 'F')
 *  universel 2005+. */
function renderDropRef(
	plan: import("../ir/plan").DropRefPlan,
	namespace: string
): NativeQuery {
	const dropText = `ALTER TABLE ${qualified(namespace, plan.target)} DROP CONSTRAINT ${quoteIdent(plan.name)}`;
	if (!plan.ifExists) return ddlQuery(dropText);
	return ddlQuery(
		`IF OBJECT_ID(${nstr(qualified(namespace, plan.name))}, N'F') IS NOT NULL ${dropText}`
	);
}

/** Nom qualifié de la table metadata enums + DDL de bootstrap (créée au
 *  premier `create enum` — M/5 sait déjà la lire, shape figé). */
function enumsMetaTable(namespace: string): string {
	return `${quoteIdent(namespace)}.[_snql_enums]`;
}

/** Clé nommée comme Prisma la nommerait : un modèle peut déclarer la table sans `map:`. */
function ensureEnumsTableSql(namespace: string): string {
	return (
		`IF OBJECT_ID(${nstr(`${quoteIdent(namespace)}.[_snql_enums]`)}, N'U') IS NULL ` +
		`CREATE TABLE ${enumsMetaTable(namespace)} ([name] nvarchar(128) NOT NULL, [members] nvarchar(max) NOT NULL, CONSTRAINT [_snql_enums_pkey] PRIMARY KEY ([name]))`
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
 * `add enum member` — append par STUFF sur le `]` final (universel 2005+ :
 * JSON_MODIFY = 2016+ et OPENJSON = compat ≥ 130, passe 2014 M/7). Le
 * member JSON-quoted est bindé ; le dedup passe par NOT LIKE sur la forme
 * quoted avec les wildcards LIKE échappés (`_` est un joker — un member
 * `a_b` sans escape matcherait `aXb`). Déjà présent → 0 row affected,
 * silence D3 miroir `ADD VALUE IF NOT EXISTS` PG. Enum inconnu → 0 row
 * silencieux (même comportement que l'`$addToSet` Mongo, documenté).
 */
function renderAddEnumMember(
	plan: import("../ir/plan").AddEnumMemberPlan,
	namespace: string
): NativeQuery {
	const params = newParams();
	const nameRef = params.add(plan.name);
	const quotedMember = JSON.stringify(plan.member);
	const quotedRef = params.add(quotedMember);
	const likePattern = `%${quotedMember.replace(/[\\%_[]/g, (c) => `\\${c}`)}%`;
	const likeRef = params.add(likePattern);
	const meta = enumsMetaTable(namespace);
	const update =
		`UPDATE ${meta} SET [members] = CASE WHEN [members] = '[]' ` +
		`THEN '[' + ${quotedRef} + ']' ` +
		`ELSE STUFF([members], LEN([members]), 1, ',' + ${quotedRef} + ']') END ` +
		`WHERE [name] = ${nameRef} AND [members] NOT LIKE ${likeRef} ESCAPE '\\'`;
	// Les colonnes de l'enum portent ses valeurs dans leur CHECK : réécrit
	// avec la nouvelle, dans la même transaction.
	const usage = plan.usage;
	const text =
		usage === undefined
			? update
			: [
					"SET XACT_ABORT ON;",
					"BEGIN TRAN;",
					`${update};`,
					...usage.columns.map((c) =>
						enumCheckRewrite(
							namespace,
							c.table,
							c.column,
							usage.members.includes(plan.member)
								? usage.members
								: [...usage.members, plan.member]
						)
					),
					"COMMIT;"
				].join("\n");
	return {
		engine: "mssql",
		kind: "sql",
		text,
		params: params.all(),
		paramSpans: params.allSpans()
	};
}

/** CHECK `ck_<t>_<c>_enum` d'une colonne d'enum, reposé avec `members`. */
function enumCheckRewrite(
	namespace: string,
	table: string,
	column: string,
	members: readonly string[]
): string {
	const target = `${quoteIdent(namespace)}.${quoteIdent(table)}`;
	const check = quoteIdent(`ck_${table}_${column}_enum`);
	return (
		`ALTER TABLE ${target} DROP CONSTRAINT IF EXISTS ${check}; ` +
		`ALTER TABLE ${target} WITH CHECK ADD CONSTRAINT ${check} CHECK (${quoteIdent(column)} IN (${members.map(nstr).join(", ")}));`
	);
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
