import { SnqlError } from "../diagnostics";
import { SNQL_FUNCTIONS } from "../functions";
import type {
	CastTarget,
	CompareOp,
	LogicalPlan,
	MutationPlan,
	PlanExpr,
	PlanProjectField,
	PlanRowValue,
	PlanSortKey,
	SqlValue,
	TransactionPlan,
	TransactionPlanItem
} from "../ir/plan";
import { isSqlDecimal, linearize } from "../ir/plan";
import type { Span } from "../lexer/token";
import type {
	Mapper,
	NativeQuery,
	SerializedSpan,
	SqlQuery,
	SqlTransaction,
	SqlTransactionStep
} from "./mapper";

/**
 * Mapper Postgres — pur, génère SQL + paramètres bindés ($1, $2…).
 *
 * Fidèle à l'ordre du pipeline : l'IR est une chaîne d'opérateurs où l'ORDRE est
 * sémantique. On l'émet en un seul SELECT tant que l'ordre reste compatible avec
 * l'évaluation SQL ; sinon on matérialise le SELECT courant en sous-requête.
 *
 * Le `join` (with) est **embed** : chaque ligne reçoit un tableau JSON des lignes
 * droites matchées, via une sous-requête corrélée `json_agg` (→ ADR-008).
 *
 * Sûreté : valeurs TOUJOURS paramétrées ; identifiants validés puis quotés.
 */
export const postgresMapper: Mapper = {
	engine: "postgres",
	map(plan: LogicalPlan): NativeQuery {
		const params = new ParamList();
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
		const params = new ParamList();
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
	 * Sprint T2/15 : rend un TransactionPlan en SqlTransaction pré-flat avec
	 * savepoints. Chaque statement porte sa propre ParamList (les $1..$N sont
	 * scopés au statement — l'engine bind par statement).
	 */
	mapTransaction(plan: TransactionPlan): SqlTransaction {
		const steps: SqlTransactionStep[] = [];
		flattenTransactionBody(plan.body, steps);
		return plan.isolation !== undefined
			? { engine: "postgres", kind: "transaction", isolation: plan.isolation, steps }
			: { engine: "postgres", kind: "transaction", steps };
	}
};

function flattenTransactionBody(
	body: readonly TransactionPlanItem[],
	out: SqlTransactionStep[]
): void {
	for (const item of body) {
		if (item.kind === "read") {
			out.push({ kind: "statement", query: renderReadAsSqlQuery(item.plan) });
		} else if (item.kind === "write") {
			out.push({ kind: "statement", query: renderWriteAsSqlQuery(item.plan) });
		} else {
			// savepoint
			out.push({ kind: "savepoint-begin", name: item.name });
			flattenTransactionBody(item.body, out);
			out.push({ kind: "savepoint-release", name: item.name });
		}
	}
}

function renderReadAsSqlQuery(plan: LogicalPlan): SqlQuery {
	const params = new ParamList();
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
	const params = new ParamList();
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
 * Codegen des mutations. Valeurs TOUJOURS paramétrées, identifiants quotés.
 * `RETURNING *` : `execute` récupère les lignes affectées (et leur nombre).
 * Sprint T2/13 : `returnRowCount === true` droppe le `RETURNING *` — le
 * driver renvoie alors seulement rowCount (rows = []).
 */
function renderMutation(plan: MutationPlan, params: ParamList): string {
	switch (plan.op) {
		case "insert": {
			const cols = plan.columns.map(quoteIdent).join(", ");
			const returning = plan.returnRowCount === true ? "" : " RETURNING *";
			// Sprint T2/14 : INSERT SELECT — pas de VALUES, on injecte le
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
			// Sprint T2/14 : `UPDATE t [AS a] [SET ...] [FROM x AS b, y AS c]
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
 * Sprint T2/13 : rend une clause ON CONFLICT PG. `ignore` → `DO NOTHING`.
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
	span?: Span
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

// Phases = ordre d'évaluation logique d'un SELECT. Une étape ne peut rejoindre le
// SELECT courant que si sa phase ne « recule » pas (et si son slot est libre).
// Sprint T2/7 : ordre canonique SNQL aligné SQL évaluation :
// with(join) → where(filter) → group → having → pick(project) → sort → limit.
// Cela permet à sort de référencer les alias du pick (comme ORDER BY après SELECT en SQL).
const PHASE = {
	filter: 1,
	join: 2,
	group: 3,
	having: 4,
	project: 5,
	sort: 6,
	limit: 7
} as const;

interface JoinSpec {
	readonly collection: string;
	readonly as: string;
	readonly localField: readonly string[];
	readonly foreignField: readonly string[];
	readonly innerAlias: string; // alias de la table interne (évite le shadowing en self-join)
	/**
	 * `embed` : json_agg corrélé — l'alias devient un tableau JSON dans la sortie
	 *   (one-to-many). Les refs `alias.field` en pick/where ne sont pas résolvables.
	 * `join` : LEFT JOIN classique — l'alias est une vraie source SQL, ses colonnes
	 *   sont projetables et filtrables. `pick alias` seul rend un objet unique via
	 *   `row_to_json(alias)`.
	 */
	readonly kind: "embed" | "join";
}

interface Select {
	from: string;
	base: string; // référence pour qualifier les champs (alias ou nom de collection)
	where: PlanExpr[];
	joins: JoinSpec[];
	project: readonly PlanProjectField[] | null;
	// Sprint T2/7 : GROUP BY / HAVING slots. Peuplés quand un aggregate op est
	// absorbé et qu'il porte des groupKeys/having. Null par défaut.
	groupKeys: readonly (readonly string[])[] | null;
	having: PlanExpr | null;
	// Sprint T2/10 : DISTINCT / DISTINCT ON.
	distinct: boolean;
	distinctOnKeys: readonly (readonly string[])[] | null;
	order: readonly PlanSortKey[] | null;
	limit: number | null;
	offset: number | null;
	maxPhase: number;
}

function renderPlan(plan: LogicalPlan, params: ParamList): string {
	const ops = linearize(plan);
	const scan = ops[0];
	if (scan === undefined || scan.op !== "scan") {
		throw new SnqlError(
			"Plan sans collection source (scan manquant)",
			"codegen_no_scan"
		);
	}

	let current = emptySelect(
		renderFrom(scan.collection, scan.alias),
		scan.alias ?? scan.collection
	);
	let depth = 0;
	for (let i = 1; i < ops.length; i += 1) {
		const op = ops[i];
		if (op === undefined) {
			continue;
		}
		if (!canAbsorb(current, op)) {
			const inner = renderSelect(current, params);
			const alias = `t${depth}`;
			current = emptySelect(`(${inner}) AS ${quoteIdent(alias)}`, alias);
			depth += 1;
		}
		absorb(current, op);
	}
	return renderSelect(current, params);
}

function emptySelect(from: string, base: string): Select {
	return {
		from,
		base,
		where: [],
		joins: [],
		project: null,
		groupKeys: null,
		having: null,
		distinct: false,
		distinctOnKeys: null,
		order: null,
		limit: null,
		offset: null,
		maxPhase: 0
	};
}

function canAbsorb(sel: Select, op: LogicalPlan): boolean {
	switch (op.op) {
		case "scan":
			return false;
		case "filter":
			// Un WHERE après un LEFT JOIN est standard SQL — pas besoin de matérialiser
			// tant que les joins déjà absorbés sont tous `kind: "join"`. Un embed
			// json_agg reste dans la SELECT-list, on ne peut pas WHERE dessus.
			return (
				sel.maxPhase <= PHASE.filter ||
				sel.joins.every((j) => j.kind === "join")
			);
		case "join":
			return sel.maxPhase <= PHASE.join;
		case "project":
		case "aggregate":
			// La SELECT-list est indépendante de WHERE/ORDER BY/LIMIT : un `project`
			// (ou `aggregate` sprint T2/6, même slot mutex) peut rejoindre le SELECT
			// courant tant que son slot est libre. PG accepte SELECT agg FROM t sans
			// GROUP BY natif (implicit grouping) → zero refactor sprint 6.
			return sel.project === null;
		case "sort":
			return sel.order === null && sel.maxPhase <= PHASE.sort;
		case "limit":
			return sel.limit === null && sel.offset === null;
	}
}

function absorb(sel: Select, op: LogicalPlan): void {
	switch (op.op) {
		case "scan":
			return;
		case "filter":
			sel.where.push(op.predicate);
			sel.maxPhase = Math.max(sel.maxPhase, PHASE.filter);
			return;
		case "join":
			sel.joins.push({
				collection: op.collection,
				as: op.as,
				localField: op.localField,
				foreignField: op.foreignField,
				innerAlias: `__j${sel.joins.length}`,
				kind: op.kind
			});
			sel.maxPhase = Math.max(sel.maxPhase, PHASE.join);
			return;
		case "project":
			sel.project = op.fields;
			// Sprint T2/10 : DISTINCT / DISTINCT ON absorbés dans le SELECT.
			if (op.unique === true) sel.distinct = true;
			if (op.distinctOnKeys !== undefined) sel.distinctOnKeys = op.distinctOnKeys;
			sel.maxPhase = Math.max(sel.maxPhase, PHASE.project);
			return;
		case "aggregate":
			// Sprint T2/6 : aggregate rend une SELECT-list comme project pour PG
			// (implicit grouping sans GROUP BY quand aucun field bare).
			// Sprint T2/7 : GROUP BY explicit quand op.groupKeys non-empty ;
			// HAVING quand op.having présent.
			sel.project = op.fields;
			if (op.groupKeys !== undefined) {
				sel.groupKeys = op.groupKeys;
				sel.maxPhase = Math.max(sel.maxPhase, PHASE.group);
			}
			if (op.having !== undefined) {
				sel.having = op.having;
				sel.maxPhase = Math.max(sel.maxPhase, PHASE.having);
			}
			sel.maxPhase = Math.max(sel.maxPhase, PHASE.project);
			return;
		case "sort":
			sel.order = op.keys;
			sel.maxPhase = Math.max(sel.maxPhase, PHASE.sort);
			return;
		case "limit":
			sel.limit = op.count;
			sel.offset = op.offset ?? null;
			sel.maxPhase = Math.max(sel.maxPhase, PHASE.limit);
			return;
	}
}

function renderSelect(sel: Select, params: ParamList): string {
	// Sprint T2/10 : DISTINCT / DISTINCT ON insérés entre SELECT et la liste.
	// DISTINCT ON prend priorité si les 2 sont set (parser ne permet pas
	// mais defense).
	let selectPrefix = "SELECT";
	if (sel.distinctOnKeys !== null && sel.distinctOnKeys.length > 0) {
		selectPrefix = `SELECT DISTINCT ON (${sel.distinctOnKeys.map((k) => renderPath(k)).join(", ")})`;
	} else if (sel.distinct) {
		selectPrefix = "SELECT DISTINCT";
	}
	const parts: string[] = [
		`${selectPrefix} ${renderSelectList(sel, params)}`,
		`FROM ${sel.from}`
	];

	// Les joins `kind: "join"` sont matérialisés en LEFT JOIN — leurs colonnes
	// sont directement projetables/filtrables. Les `embed` restent des sous-
	// requêtes json_agg tirées dans la SELECT-list.
	for (const join of sel.joins) {
		if (join.kind === "join") {
			parts.push(renderLeftJoin(join, sel.base));
		}
	}

	if (sel.where.length > 0) {
		parts.push(
			`WHERE ${sel.where.map((f) => renderExpr(f, params)).join(" AND ")}`
		);
	}
	if (sel.groupKeys && sel.groupKeys.length > 0) {
		parts.push(`GROUP BY ${sel.groupKeys.map((k) => renderPath(k)).join(", ")}`);
	}
	if (sel.having) {
		parts.push(`HAVING ${renderExpr(sel.having, params)}`);
	}
	if (sel.order && sel.order.length > 0) {
		parts.push(`ORDER BY ${sel.order.map(renderSortKey).join(", ")}`);
	}
	if (sel.limit !== null) {
		parts.push(`LIMIT ${params.add(sel.limit)}`);
	}
	if (sel.offset !== null) {
		parts.push(`OFFSET ${params.add(sel.offset)}`);
	}
	return parts.join(" ");
}

function renderSelectList(sel: Select, params: ParamList): string {
	if (sel.project) {
		return sel.project
			.map((field) => renderProjectField(field, sel, params))
			.join(", ");
	}
	if (sel.joins.length > 0) {
		const columns = [`${quoteIdent(sel.base)}.*`];
		for (const join of sel.joins) {
			columns.push(`${renderJoinAliasSource(join, sel.base)} AS ${quoteIdent(join.as)}`);
		}
		return columns.join(", ");
	}
	return "*";
}

/**
 * Un champ projeté qui pointe vers un alias de join `embed` devient sa sous-
 * requête json_agg. Pour un `join`, si l'utilisateur pointe l'alias entier
 * (`pick x`), on retourne `row_to_json(x)` pour homogénéiser avec l'embed
 * (un seul champ = un objet). Sinon, un chemin qualifié `alias.field` traverse
 * naturellement le LEFT JOIN et devient une ref SQL directe.
 */
function renderProjectField(
	field: PlanProjectField,
	sel: Select,
	params: ParamList
): string {
	if (field.path.length === 1) {
		const join = sel.joins.find((candidate) => candidate.as === field.path[0]);
		if (join !== undefined) {
			return `${renderJoinAliasSource(join, sel.base)} AS ${quoteIdent(field.alias ?? join.as)}`;
		}
	}
	return renderProjection(field, params);
}

/**
 * Source SQL de l'alias d'un join projeté ou sélectionné en globalité :
 *  - `embed` → sous-requête `json_agg` corrélée (comportement historique) ;
 *  - `join`  → `row_to_json(alias)` pour rendre l'objet unique de la row jointe.
 */
function renderJoinAliasSource(join: JoinSpec, base: string): string {
	if (join.kind === "embed") {
		return renderEmbedSubquery(join, base);
	}
	// LEFT JOIN déjà émis dans le FROM — on projette juste l'objet.
	return `row_to_json(${quoteIdent(join.as)})`;
}

function renderEmbedSubquery(join: JoinSpec, base: string): string {
	// Self-join : le nom de la table interne masquerait la base → on l'aliase.
	const selfJoin = join.collection === base;
	const innerRef = selfJoin ? join.innerAlias : join.collection;
	const inner = quoteIdent(innerRef);
	const fromClause = selfJoin
		? `${quoteIdent(join.collection)} AS ${inner}`
		: inner;
	const foreign = qualify(innerRef, join.foreignField);
	const local = qualify(base, join.localField);
	return `(SELECT COALESCE(json_agg(${inner}.*), '[]'::json) FROM ${fromClause} WHERE ${foreign} = ${local})`;
}

function renderLeftJoin(join: JoinSpec, base: string): string {
	// Self-join : on aliase toujours pour éviter l'ambigüité avec la base.
	const selfJoin = join.collection === base;
	const table = quoteIdent(join.collection);
	const alias = quoteIdent(join.as);
	const table_ref = selfJoin || join.as !== join.collection
		? `${table} AS ${alias}`
		: table;
	const local = qualify(base, join.localField);
	const foreign = qualify(join.as, join.foreignField);
	return `LEFT JOIN ${table_ref} ON ${foreign} = ${local}`;
}

function qualify(ref: string, path: readonly string[]): string {
	return `${quoteIdent(ref)}.${path.map(quoteIdent).join(".")}`;
}

class ParamList {
	private readonly values: unknown[] = [];
	private readonly spans: (SerializedSpan | undefined)[] = [];

	add(value: SqlValue, span?: Span): string {
		// Un décimal exact est bindé comme texte : Postgres le caste vers le type
		// de la colonne (NUMERIC/text/jsonb…) via l'inférence par colonne cible
		// pour les INSERT/UPDATE/comparaisons. Le cast `::numeric` n'est appliqué
		// que dans un contexte arithmétique — cf. `renderArithOperand` — sinon
		// il casse les colonnes non-numeric (`WHERE varchar_col = 1.5` → 42883).
		this.values.push(isSqlDecimal(value) ? value.raw : value);
		this.spans.push(
			span !== undefined
				? [span.start.offset, span.end.offset - span.start.offset]
				: undefined
		);
		return `$${this.values.length}`;
	}

	all(): readonly unknown[] {
		return this.values;
	}

	allSpans(): readonly (SerializedSpan | undefined)[] {
		return this.spans;
	}
}

const COMPARE_SQL: Readonly<Record<CompareOp, string>> = {
	eq: "=",
	ne: "<>",
	lt: "<",
	gt: ">",
	le: "<=",
	ge: ">=",
	like: "LIKE"
};

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

function renderExpr(expr: PlanExpr, params: ParamList): string {
	switch (expr.kind) {
		case "literal":
			return expr.value === null ? "NULL" : params.add(expr.value, expr.span);
		case "field":
			return renderPath(expr.path);
		case "compare":
			return `${renderExpr(expr.left, params)} ${COMPARE_SQL[expr.op]} ${renderExpr(expr.right, params)}`;
		case "and":
			return `(${renderExpr(expr.left, params)} AND ${renderExpr(expr.right, params)})`;
		case "or":
			return `(${renderExpr(expr.left, params)} OR ${renderExpr(expr.right, params)})`;
		case "not":
			return `(NOT ${renderExpr(expr.operand, params)})`;
		case "isNull":
			return `${renderExpr(expr.operand, params)} IS ${expr.negated ? "NOT NULL" : "NULL"}`;
		case "in": {
			// `x IN ()` est invalide en SQL ; l'ensemble vide est toujours faux.
			if (expr.values.length === 0) {
				return "FALSE";
			}
			const target = renderExpr(expr.target, params);
			// Sprint T2/11 : `x in (subquery)` — le subquery se rend déjà en
			// `(SELECT ...)`, donc pas de parens supplémentaires. Détecte le
			// cas single-value=subquery.
			if (
				expr.values.length === 1 &&
				expr.values[0]?.kind === "subquery"
			) {
				return `${target} IN ${renderExpr(expr.values[0], params)}`;
			}
			const list = expr.values.map((v) => renderExpr(v, params)).join(", ");
			return `${target} IN (${list})`;
		}
		case "arith":
			// Parens défensives systématiques : le codegen ne dépend pas de la
			// précédence native PG, chaque sous-expr est isolée. Les opérandes
			// sont rendus via `renderArithOperand` qui annote un littéral décimal
			// avec `::numeric` — sinon PG essaie de caster "0.1" en int quand
			// l'autre côté est int (`int_col * 0.1` → 22P02).
			return `(${renderArithOperand(expr.left, params)} ${expr.op} ${renderArithOperand(expr.right, params)})`;
		case "call": {
			// Délégation au registre : le renderer PG de la fonction assemble le SQL
			// à partir des args (déjà rendus via ctx.renderExpr). Le planner a déjà
			// vérifié que la fonction existe pour PG — l'assert defense-in-depth
			// couvre uniquement un bug de synchronisation registre ↔ capabilities.
			const entry = SNQL_FUNCTIONS.get(expr.name);
			if (entry?.engines.postgres === undefined) {
				throw new SnqlError(
					`Fonction '${expr.name}' : renderer Postgres absent du registre`,
					"codegen_missing_function_mapping"
				);
			}
			// Sprint T2/6 : propage star/unique flags aux renderers aggregates.
			// Sprint T2/8 : propage sortKeys aux renderers aggregateMulti.
			// Les renderers scalar existants ignorent ces flags (backward compat).
			return entry.engines.postgres(expr.args, {
				renderExpr: (arg) => renderExpr(arg as PlanExpr, params),
				addParam: (v) => params.add(v as SqlValue),
				...(expr.star === true ? { star: true } : {}),
				...(expr.unique === true ? { unique: true } : {}),
				...(expr.sortKeys !== undefined && expr.sortKeys.length > 0
					? { sortKeys: expr.sortKeys }
					: {})
			}) as string;
		}
		case "cast":
			// SQL standard : `CAST(x AS T)` — préféré à `x::T` pour la lisibilité
			// (idiome portable, aligné avec la surface SNQL).
			return `CAST(${renderExpr(expr.operand, params)} AS ${PG_CAST_TYPE[expr.target]})`;
		case "object": {
			// jsonb_build_object($1::text, $2::TYPE, $3::text, $4::TYPE, ...) —
			// clés ET valeurs bindées (anti-injection sur clés user-controlled type
			// `O'Brien`). Cast `::text` sur les KEYS obligatoire pour désambigüer
			// l'overload variadic PG (sans cast, param unknown → 42P18
			// `could not determine data type of parameter $1` — même famille que
			// pgConcat ::text). Cast type PG natif per-scalar sur les VALUES via
			// `renderJsonValue` : sans annotation, `$N` unknown → text par défaut →
			// `{n:42}` deviendrait `{"n":"42"}` dans le jsonb (bug destructeur).
			if (expr.entries.length === 0) return "jsonb_build_object()";
			const parts: string[] = [];
			for (const entry of expr.entries) {
				parts.push(`${params.add(entry.key)}::text`);
				parts.push(renderJsonValue(entry.value, params));
			}
			return `jsonb_build_object(${parts.join(", ")})`;
		}
		case "array": {
			// jsonb_build_array($1::TYPE, ...) — même helper renderJsonValue.
			// Type retour jsonb (cohérent avec Lentille B). Refus explicite du
			// `ARRAY[...]::T[]` natif PG (type homogène incompatible json-first).
			if (expr.items.length === 0) return "jsonb_build_array()";
			const parts = expr.items.map((item) => renderJsonValue(item, params));
			return `jsonb_build_array(${parts.join(", ")})`;
		}
		case "case": {
			// CASE WHEN <c1> THEN <v1> WHEN <c2> THEN <v2> ELSE <e> END.
			// Parens autour : `case` peut apparaître comme opérande d'un
			// compare/arith, PG accepte l'expression nue mais le formateur
			// SNQL préfère l'isolement défensif (miroir arith).
			const whens = expr.branches
				.map(
					(b) =>
						`WHEN ${renderExpr(b.cond, params)} THEN ${renderExpr(b.value, params)}`
				)
				.join(" ");
			const elseSql = renderExpr(expr.elseValue, params);
			return `(CASE ${whens} ELSE ${elseSql} END)`;
		}
		case "windowCall": {
			// Sprint T2/9 : `FN() OVER (PARTITION BY ... ORDER BY ...)`. Le
			// renderer window (pgRowNumber/pgRank/pgDenseRank) retourne juste
			// `FN()` ; on append la clause OVER.
			const entry = SNQL_FUNCTIONS.get(expr.name);
			if (entry?.engines.postgres === undefined) {
				throw new SnqlError(
					`Window function '${expr.name}' : renderer Postgres absent`,
					"codegen_missing_function_mapping"
				);
			}
			const fnSql = entry.engines.postgres(expr.args, {
				renderExpr: (a) => renderExpr(a as PlanExpr, params),
				addParam: (v) => params.add(v as SqlValue)
			}) as string;
			const parts: string[] = [];
			if (expr.partitionKeys.length > 0) {
				parts.push(
					`PARTITION BY ${expr.partitionKeys.map((k) => renderPath(k)).join(", ")}`
				);
			}
			if (expr.sortKeys.length > 0) {
				parts.push(
					`ORDER BY ${expr.sortKeys
						.map(
							(k) => `${renderPath(k.path)} ${k.direction === "desc" ? "DESC" : "ASC"}`
						)
						.join(", ")}`
				);
			}
			return `${fnSql} OVER (${parts.join(" ")})`;
		}
		case "subquery": {
			// Sprint T2/11 : `(SELECT ...)` inline. Le sous-plan est rendu via
			// renderPlan avec les mêmes params (les $N sont partagés — tous
			// bindés séquentiellement). Le résultat est wrappé en parens.
			return `(${renderPlan(expr.plan, params)})`;
		}
		case "exists": {
			// Sprint T2/11 : `EXISTS (SELECT ... )`. Idem — sous-plan inline.
			return `EXISTS (${renderPlan(expr.subplan, params)})`;
		}
		case "upsertNew":
			// Sprint T2/13 : `new.<col>` dans `on conflict edit set/where` → PG
			// binde la row proposée sous l'alias `EXCLUDED`.
			return `EXCLUDED.${quoteIdent(expr.column)}`;
	}
}

/**
 * Rend une value pour un object/array literal PG. Annote les literals
 * scalaires nus avec leur type PG canonique — sans quoi `$N` unknown est
 * inféré text par défaut et un scalaire `42` devient string `"42"` dans le
 * jsonb final (silent bug destructeur). Les non-literals passent par
 * renderExpr standard (leur type est inféré via colonne / retour de fn).
 */
function renderJsonValue(expr: PlanExpr, params: ParamList): string {
	if (expr.kind !== "literal") return renderExpr(expr, params);
	const v = expr.value;
	if (v === null) return "NULL";
	if (isSqlDecimal(v)) return `${params.add(v, expr.span)}::numeric`;
	if (typeof v === "boolean") return `${params.add(v, expr.span)}::boolean`;
	if (typeof v === "bigint") return `${params.add(v, expr.span)}::bigint`;
	if (typeof v === "number") {
		return Number.isInteger(v)
			? `${params.add(v, expr.span)}::bigint`
			: `${params.add(v, expr.span)}::double precision`;
	}
	// string : cast ::text explicite (aligné pgConcat pattern anti-injection).
	return `${params.add(v, expr.span)}::text`;
}

/**
 * Opérande arithmétique : annote un littéral décimal avec `::numeric` pour que
 * PG type le param correctement dans un contexte où l'autre côté est int.
 * Toutes les autres formes (field, call, arith imbriqué, literal non-decimal)
 * passent par `renderExpr` standard — leur type est inféré via colonne / retour
 * de fonction / cast d'un opérande voisin.
 */
function renderArithOperand(expr: PlanExpr, params: ParamList): string {
	if (
		expr.kind === "literal" &&
		expr.value !== null &&
		isSqlDecimal(expr.value)
	) {
		return `${params.add(expr.value, expr.span)}::numeric`;
	}
	return renderExpr(expr, params);
}

function renderProjection(field: PlanProjectField, params: ParamList): string {
	// Une expression projetée rend son SQL calculé et exige toujours un alias
	// (contrat lower_pick_expr_alias). Un chemin simple garde le comportement historique.
	if (field.expr !== undefined) {
		return `${renderExpr(field.expr, params)} AS ${quoteIdent(field.alias as string)}`;
	}
	const path = renderPath(field.path);
	return field.alias !== undefined
		? `${path} AS ${quoteIdent(field.alias)}`
		: path;
}

function renderSortKey(key: PlanSortKey): string {
	return `${renderPath(key.path)} ${key.direction === "desc" ? "DESC" : "ASC"}`;
}

function renderFrom(collection: string, alias: string | undefined): string {
	const table = quoteIdent(collection);
	return alias !== undefined ? `${table} AS ${quoteIdent(alias)}` : table;
}

function renderPath(path: readonly string[]): string {
	return path.map(quoteIdent).join(".");
}

/**
 * Sprint T2/14 : rend un path pour une clé de join mutation. Si le path
 * n'a qu'un segment (col bare), on préfixe avec `alias` pour éviter les
 * ambiguïtés (`t.col = x.col`). Sinon on rend tel quel (path déjà qualifié).
 */
function renderJoinPath(path: readonly string[], alias: string): string {
	if (path.length === 1) return `${quoteIdent(alias)}.${quoteIdent(path[0]!)}`;
	return renderPath(path);
}

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function quoteIdent(name: string): string {
	if (!IDENT_RE.test(name)) {
		throw new SnqlError(
			`Identifiant invalide '${name}'`,
			"codegen_invalid_ident"
		);
	}
	return `"${name}"`;
}
