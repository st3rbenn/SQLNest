import { SnqlError } from "../diagnostics";
import type {
	CastTarget,
	LogicalPlan,
	MutationPlan,
	PlanExpr,
	PlanRowValue,
	RawPlan,
	TransactionPlan
} from "../ir/plan";
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
	}
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
