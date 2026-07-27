import { SnqlError } from "../diagnostics";
import type {
	CompareOp,
	LogicalPlan,
	PlanExpr,
	PlanProjectField,
	PlanSortKey,
	SqlValue
} from "../ir/plan";
import { linearize } from "../ir/plan";
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
	}
};

// Phases = ordre d'évaluation logique d'un SELECT. Une étape ne peut rejoindre le
// SELECT courant que si sa phase ne « recule » pas (et si son slot est libre).
const PHASE = { filter: 1, join: 2, project: 3, sort: 4, limit: 5 } as const;

interface JoinSpec {
	readonly collection: string;
	readonly as: string;
	readonly localField: readonly string[];
	readonly foreignField: readonly string[];
	readonly innerAlias: string; // alias de la table interne (évite le shadowing en self-join)
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
			return sel.maxPhase <= PHASE.filter;
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
				innerAlias: `__j${sel.joins.length}`
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
			columns.push(
				`${renderJoinSubquery(join, sel.base)} AS ${quoteIdent(join.as)}`
			);
		}
		return columns.join(", ");
	}
	return "*";
}

/** Un champ projeté qui correspond à un join devient sa sous-requête json_agg. */
function renderProjectField(field: PlanProjectField, sel: Select): string {
	if (field.path.length === 1) {
		const join = sel.joins.find((candidate) => candidate.as === field.path[0]);
		if (join !== undefined) {
			return `${renderJoinSubquery(join, sel.base)} AS ${quoteIdent(field.alias ?? join.as)}`;
		}
	}
	return renderProjection(field);
}

function renderJoinSubquery(join: JoinSpec, base: string): string {
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

function qualify(ref: string, path: readonly string[]): string {
	return `${quoteIdent(ref)}.${path.map(quoteIdent).join(".")}`;
}

class ParamList {
	private readonly values: unknown[] = [];

	add(value: SqlValue): string {
		this.values.push(value);
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
