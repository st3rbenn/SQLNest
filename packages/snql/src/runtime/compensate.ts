import type {
	CompareOp,
	PlanExpr,
	PlanProjectField,
	PlanSortKey
} from "../ir/plan";
import type { CompensationOp } from "../planner/planner";

/** Une ligne de résultat, engine-agnostique. */
export type Row = Record<string, unknown>;

/**
 * Exécute les opérateurs de compensation en mémoire, au-dessus des rows renvoyées
 * par le pushdown. Pur (aucune I/O) : c'est la **référence sémantique** de SNQL —
 * l'évaluateur applique la logique à 3 valeurs (3VL) de SQL, indépendamment du moteur.
 */
export function compensate(
	ops: readonly CompensationOp[],
	rows: readonly Row[]
): Row[] {
	let out: Row[] = [...rows];
	for (const op of ops) {
		switch (op.op) {
			case "filter":
				out = out.filter((row) => evalBool(op.predicate, row) === true);
				break;
			case "project":
				out = out.map((row) => projectRow(row, op.fields));
				break;
			case "sort":
				out = sortRows(out, op.keys);
				break;
			case "limit": {
				const start = op.offset ?? 0;
				out = out.slice(start, start + op.count);
				break;
			}
		}
	}
	return out;
}

// --- Évaluation (3VL : true / false / null=unknown) ---

function evalValue(expr: PlanExpr, row: Row): unknown {
	if (expr.kind === "literal") {
		return expr.value;
	}
	if (expr.kind === "field") {
		return getPath(row, expr.path);
	}
	// Expression booléenne utilisée comme valeur.
	return evalBool(expr, row);
}

function evalBool(expr: PlanExpr, row: Row): boolean | null {
	switch (expr.kind) {
		case "compare":
			return evalCompare(
				expr.op,
				evalValue(expr.left, row),
				evalValue(expr.right, row)
			);
		case "and":
			return and3(evalBool(expr.left, row), evalBool(expr.right, row));
		case "or":
			return or3(evalBool(expr.left, row), evalBool(expr.right, row));
		case "not": {
			const value = evalBool(expr.operand, row);
			return value === null ? null : !value;
		}
		case "in":
			return evalIn(
				evalValue(expr.target, row),
				expr.values.map((v) => evalValue(v, row))
			);
		case "isNull": {
			const value = evalValue(expr.operand, row);
			const missing = value === null || value === undefined;
			return expr.negated ? !missing : missing;
		}
		case "literal":
		case "field":
			return coerceBool(evalValue(expr, row));
	}
}

function evalCompare(
	op: CompareOp,
	left: unknown,
	right: unknown
): boolean | null {
	if (isUnknownOperand(left) || isUnknownOperand(right)) {
		return null; // comparaison impliquant NULL/NaN → UNKNOWN
	}
	if (op === "like") {
		return likeMatch(String(left), String(right));
	}
	const order = compareValues(left, right);
	switch (op) {
		case "eq":
			return order === 0;
		case "ne":
			return order !== 0;
		case "lt":
			return order < 0;
		case "gt":
			return order > 0;
		case "le":
			return order <= 0;
		case "ge":
			return order >= 0;
	}
}

function evalIn(target: unknown, values: readonly unknown[]): boolean | null {
	if (values.length === 0) {
		return false; // ensemble vide → toujours faux, même pour NULL (parité SQL)
	}
	if (isNullish(target)) {
		return null;
	}
	let hasNull = false;
	for (const value of values) {
		if (isNullish(value)) {
			hasNull = true;
		} else if (compareValues(target, value) === 0) {
			return true;
		}
	}
	return hasNull ? null : false; // `x IN (…, NULL)` sans match → UNKNOWN
}

function and3(a: boolean | null, b: boolean | null): boolean | null {
	if (a === false || b === false) {
		return false;
	}
	if (a === null || b === null) {
		return null;
	}
	return true;
}

function or3(a: boolean | null, b: boolean | null): boolean | null {
	if (a === true || b === true) {
		return true;
	}
	if (a === null || b === null) {
		return null;
	}
	return false;
}

function coerceBool(value: unknown): boolean | null {
	if (isNullish(value)) {
		return null;
	}
	return Boolean(value);
}

// --- Projection / tri / accès ---

function projectRow(row: Row, fields: readonly PlanProjectField[]): Row {
	const out: Row = {};
	for (const field of fields) {
		const key = field.alias ?? field.path[field.path.length - 1] ?? "";
		out[key] = getPath(row, field.path);
	}
	return out;
}

function sortRows(rows: readonly Row[], keys: readonly PlanSortKey[]): Row[] {
	return [...rows].sort((a, b) => {
		for (const key of keys) {
			const order = compareForSort(getPath(a, key.path), getPath(b, key.path));
			if (order !== 0) {
				return key.direction === "desc" ? -order : order;
			}
		}
		return 0;
	});
}

/** Ordre de tri stable ; NULL en dernier (ASC) → en premier (DESC via la négation). */
function compareForSort(a: unknown, b: unknown): number {
	const an = isUnknownOperand(a);
	const bn = isUnknownOperand(b);
	if (an && bn) {
		return 0;
	}
	if (an) {
		return 1;
	}
	if (bn) {
		return -1;
	}
	return compareValues(a, b);
}

function getPath(row: Row, path: readonly string[]): unknown {
	let current: unknown = row;
	for (const segment of path) {
		if (
			current === null ||
			current === undefined ||
			typeof current !== "object"
		) {
			return undefined;
		}
		current = (current as Record<string, unknown>)[segment];
	}
	return current;
}

function isNullish(value: unknown): boolean {
	return value === null || value === undefined;
}

/** NULL, undefined ou NaN → « inconnu » pour les comparaisons et le tri. */
function isUnknownOperand(value: unknown): boolean {
	return isNullish(value) || (typeof value === "number" && Number.isNaN(value));
}

/** Chaîne représentant un nombre → sa valeur, sinon null. */
function numericString(value: unknown): number | null {
	if (typeof value !== "string" || value.trim() === "") {
		return null;
	}
	const n = Number(value);
	return Number.isNaN(n) ? null : n;
}

/** Valeur numérique (nombre, bigint, ou chaîne numérique), sinon null. */
function numericOf(value: unknown): number | null {
	if (typeof value === "number") {
		return Number.isNaN(value) ? null : value;
	}
	if (typeof value === "bigint") {
		return Number(value);
	}
	return numericString(value);
}

/**
 * Ordre total. Si les DEUX opérandes sont numériques (nombre, bigint ou chaîne
 * numérique) → comparaison numérique (parité SQL / casts implicites : `age > 100`
 * reste faux pour "20", et trier "100"/"20" est numérique). Sinon lexicographique.
 * (Conséquence assumée : "01000" et "1000" sont égaux — SNQL n'a pas de type de colonne.)
 */
function compareValues(a: unknown, b: unknown): number {
	const na = numericOf(a);
	const nb = numericOf(b);
	if (na !== null && nb !== null) {
		return na < nb ? -1 : na > nb ? 1 : 0;
	}
	if (typeof a === "boolean" && typeof b === "boolean") {
		return a === b ? 0 : a ? 1 : -1;
	}
	const sa = String(a);
	const sb = String(b);
	return sa < sb ? -1 : sa > sb ? 1 : 0;
}

const LIKE_SPECIAL = /[.*+?^${}()|[\]\\]/;

function likeMatch(value: string, pattern: string): boolean {
	let body = "";
	for (const ch of pattern) {
		if (ch === "%") {
			body += "[\\s\\S]*";
		} else if (ch === "_") {
			body += "[\\s\\S]";
		} else {
			body += LIKE_SPECIAL.test(ch) ? `\\${ch}` : ch;
		}
	}
	// En JS, `$` (sans flag m) ancre la fin absolue — pas besoin de `\z`.
	return new RegExp(`^${body}$`).test(value);
}
