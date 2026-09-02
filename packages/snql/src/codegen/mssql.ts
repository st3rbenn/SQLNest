import { SnqlError } from "../diagnostics";
import type { CastTarget, LogicalPlan, MutationPlan, RawPlan } from "../ir/plan";
import type { Mapper, NativeQuery } from "./mapper";
import {
	createSqlRenderer,
	type SqlDialect,
	type TypedParamKind
} from "./sql-core";

/**
 * Mapper MSSQL (T-SQL) — chantier M/3 : LECTURE. Réutilise la mécanique
 * SELECT de `sql-core` avec le dialecte T-SQL :
 *  - identifiants `[bracket]`, paramètres `@pN` (alignés sur l'adapter
 *    tedious qui bind `p1..pN`) ;
 *  - pagination `TOP (@pN)` sans offset, `OFFSET … ROWS FETCH NEXT … ROWS
 *    ONLY` avec (ORDER BY exigé → `(SELECT NULL)` forcé si absent) ;
 *  - embeds one-to-many via `FOR JSON PATH` (T-SQL n'a pas de type json :
 *    la colonne sort en nvarchar — les alias sont collectés dans
 *    `SqlQuery.jsonColumns` et l'adapter parse les strings) ;
 *  - DISTINCT ON via wrap ROW_NUMBER (stratégie core `row-number`).
 *
 * Cible dev = SQL Server 2022 ; JSON_OBJECT/JSON_ARRAY (2022+) et FOR JSON
 * (2016+) sont notés pour la passe 2014 (M/7 — compensations doctrine
 * UNIFIE). Mutations (OUTPUT/MERGE) = M/4, introspect tier-1 + let/CTE =
 * M/5, DDL = M/6 — le planner gate par capabilities/matrices, les throws
 * ici sont defense-in-depth.
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
	upsertNewRef: () => {
		throw new SnqlError(
			"upsert (`on conflict`) pas encore câblé sur MSSQL (slice M/4 — MERGE)",
			"codegen_mssql_slice_m4"
		);
	},
	onJsonColumn: (alias) => {
		jsonColumns.add(alias);
	}
};

const MSSQL = createSqlRenderer(MSSQL_DIALECT);

export const mssqlMapper: Mapper = {
	engine: "mssql",
	map(plan: LogicalPlan): NativeQuery {
		jsonColumns = new Set();
		const params = MSSQL.newParams();
		const text = MSSQL.renderPlan(plan, params);
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
	mapMutation(_plan: MutationPlan): NativeQuery {
		// Defense-in-depth : la capability `mutate` absente fait refuser le
		// planner AVANT d'arriver ici (planner typé, message chantier).
		throw new SnqlError(
			"Écritures pas encore câblées sur MSSQL (slice M/4 — OUTPUT/MERGE/transactions)",
			"codegen_mssql_slice_m4"
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
