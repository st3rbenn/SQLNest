import { SnqlError } from "../diagnostics";
import type {
	CompareOp,
	LogicalPlan,
	MutationPlan,
	PlanExpr,
	PlanProjectField,
	PlanSortKey,
	SqlValue
} from "../ir/plan";
import { isSqlDecimal, linearize } from "../ir/plan";
import type { Mapper, NativeQuery } from "./mapper";

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
		return { engine: "postgres", kind: "sql", text, params: params.all() };
	},
	mapMutation(plan: MutationPlan): NativeQuery {
		const params = new ParamList();
		const text = renderMutation(plan, params);
		return { engine: "postgres", kind: "sql", text, params: params.all() };
	}
};

/**
 * Codegen des mutations. Valeurs TOUJOURS paramétrées, identifiants quotés.
 * `RETURNING *` : `execute` récupère les lignes affectées (et leur nombre).
 */
function renderMutation(plan: MutationPlan, params: ParamList): string {
	switch (plan.op) {
		case "insert": {
			const cols = plan.columns.map(quoteIdent).join(", ");
			const rows = plan.rows
				.map(
					(row) =>
						`(${row.map((value) => renderValue(value, params)).join(", ")})`
				)
				.join(", ");
			return `INSERT INTO ${quoteIdent(plan.collection)} (${cols}) VALUES ${rows} RETURNING *`;
		}
		case "update": {
			const set = plan.assignments
				.map((a) => `${quoteIdent(a.column)} = ${renderExpr(a.value, params)}`)
				.join(", ");
			const where = renderWhere(plan.predicate, params);
			return `UPDATE ${quoteIdent(plan.collection)} SET ${set}${where} RETURNING *`;
		}
		case "delete": {
			const where = renderWhere(plan.predicate, params);
			return `DELETE FROM ${quoteIdent(plan.collection)}${where} RETURNING *`;
		}
	}
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
function renderValue(value: SqlValue, params: ParamList): string {
	return value === null ? "NULL" : params.add(value);
}

// Phases = ordre d'évaluation logique d'un SELECT. Une étape ne peut rejoindre le
// SELECT courant que si sa phase ne « recule » pas (et si son slot est libre).
const PHASE = { filter: 1, join: 2, project: 3, sort: 4, limit: 5 } as const;

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
			// La SELECT-list est indépendante de WHERE/ORDER BY/LIMIT : un `project`
			// peut rejoindre le SELECT courant tant que son slot est libre.
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
	const parts: string[] = [
		`SELECT ${renderSelectList(sel)}`,
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

function renderSelectList(sel: Select): string {
	if (sel.project) {
		return sel.project
			.map((field) => renderProjectField(field, sel))
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
function renderProjectField(field: PlanProjectField, sel: Select): string {
	if (field.path.length === 1) {
		const join = sel.joins.find((candidate) => candidate.as === field.path[0]);
		if (join !== undefined) {
			return `${renderJoinAliasSource(join, sel.base)} AS ${quoteIdent(field.alias ?? join.as)}`;
		}
	}
	return renderProjection(field);
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

	add(value: SqlValue): string {
		// Un décimal exact est bindé comme texte : Postgres le caste vers le type
		// de la colonne (NUMERIC…) sans perte, contrairement à un double JS.
		this.values.push(isSqlDecimal(value) ? value.raw : value);
		return `$${this.values.length}`;
	}

	all(): readonly unknown[] {
		return this.values;
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

function renderExpr(expr: PlanExpr, params: ParamList): string {
	switch (expr.kind) {
		case "literal":
			return expr.value === null ? "NULL" : params.add(expr.value);
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
			const list = expr.values.map((v) => renderExpr(v, params)).join(", ");
			return `${target} IN (${list})`;
		}
	}
}

function renderProjection(field: PlanProjectField): string {
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
