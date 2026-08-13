import { SnqlError } from "../diagnostics";
import { SNQL_FUNCTIONS } from "../functions/index";
import type {
	CastTarget,
	CompareOp,
	PlanExpr,
	PlanProjectField,
	PlanSortKey
} from "../ir/plan";
import { isSqlDecimal } from "../ir/plan";
import type { CompensationOp } from "../planner/planner";

/** Une ligne de résultat, engine-agnostique. */
export type Row = Record<string, unknown>;

/** Données des collections jointes, fournies au runtime pour compenser un `join`. */
export type JoinSources = Readonly<Record<string, readonly Row[]>>;

/**
 * Exécute les opérateurs de compensation en mémoire, au-dessus des rows renvoyées
 * par le pushdown. Pur (aucune I/O) : c'est la **référence sémantique** de SNQL —
 * l'évaluateur applique la logique à 3 valeurs (3VL) de SQL, indépendamment du moteur.
 * `sources` fournit les données des collections jointes (embed du `join`).
 */
export function compensate(
	ops: readonly CompensationOp[],
	rows: readonly Row[],
	sources: JoinSources = {}
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
			case "join":
				out = joinRows(out, op, sources);
				break;
		}
	}
	return out;
}

interface JoinOp {
	readonly collection: string;
	readonly as: string;
	readonly localField: readonly string[];
	readonly foreignField: readonly string[];
}

/** Embed : indexe la collection droite par foreignField, attache les matchs sous `as`. */
function joinRows(
	left: readonly Row[],
	op: JoinOp,
	sources: JoinSources
): Row[] {
	const right = sources[op.collection];
	if (right === undefined) {
		throw new SnqlError(
			`Compensation de 'join' : aucune donnée fournie pour la collection '${op.collection}' (nécessite la couche connexion)`,
			"runtime_join_no_source"
		);
	}
	const index = new Map<string, Row[]>();
	for (const row of right) {
		const key = joinKey(getPath(row, op.foreignField));
		if (key === null) {
			continue; // une clé NULL ne matche jamais (parité SQL)
		}
		const bucket = index.get(key);
		if (bucket === undefined) {
			index.set(key, [row]);
		} else {
			bucket.push(row);
		}
	}
	return left.map((row) => {
		const key = joinKey(getPath(row, op.localField));
		const matched = key !== null ? (index.get(key) ?? []) : [];
		return { ...row, [op.as]: matched };
	});
}

/** Clé de jointure : numérique (matche cross-type) ou chaîne ; null si NULL. */
function joinKey(value: unknown): string | null {
	if (isNullish(value)) {
		return null;
	}
	const numeric = numericOf(value);
	return numeric !== null ? `n:${numeric}` : `s:${String(value)}`;
}

// --- Évaluation (3VL : true / false / null=unknown) ---

function evalValue(expr: PlanExpr, row: Row): unknown {
	if (expr.kind === "literal") {
		return expr.value;
	}
	if (expr.kind === "field") {
		return getPath(row, expr.path);
	}
	if (expr.kind === "arith") {
		return evalArith(expr.op, evalValue(expr.left, row), evalValue(expr.right, row));
	}
	if (expr.kind === "call") {
		// Sprint T2/5 : dispatch registre KV. Si l'entrée expose un renderer
		// `kv`, on le délègue (short-circuit possible côté renderer — cf.
		// `kvIf` qui n'évalue jamais les deux branches). Sans renderer, la
		// fn est inconnue de KV → planner l'a filtrée en amont (Capabilities
		// forEngine("kv") vide pour cette fn) → arrivée ici = bug de sync.
		const entry = SNQL_FUNCTIONS.get(expr.name);
		if (entry?.engines.kv !== undefined) {
			return entry.engines.kv(expr.args, {
				renderExpr: (arg) => evalValue(arg as PlanExpr, row)
			});
		}
		throw new Error(
			`Runtime KV : fonction '${expr.name}' non exécutable (planner should have rejected)`
		);
	}
	if (expr.kind === "case") {
		// Sprint T2/5 : short-circuit strict. Chaque cond évaluée dans l'ordre,
		// premier `=== true` STRICT → sa value. null/false/undefined/0/'' →
		// on passe à la suivante (parité PG 3VL, pas de truthy JS). Si aucune
		// branche match → elseValue (obligatoire à la surface).
		for (const branch of expr.branches) {
			const cond = evalValue(branch.cond, row);
			if (cond === true) return evalValue(branch.value, row);
		}
		return evalValue(expr.elseValue, row);
	}
	if (expr.kind === "cast") {
		const inner = evalValue(expr.operand, row);
		if (inner === null || inner === undefined) {
			return null; // NULL propagate — parité 3VL SQL
		}
		return castValue(expr.target, inner);
	}
	// Sprint object-literals : évaluation récursive AVANT le fallback evalBool
	// pour éviter une récursion infinie (evalBool → evalValue → evalBool sur un
	// object).
	if (expr.kind === "object") {
		const out: Record<string, unknown> = {};
		for (const entry of expr.entries) {
			out[entry.key] = evalValue(entry.value, row);
		}
		return out;
	}
	if (expr.kind === "array") {
		return expr.items.map((item) => evalValue(item, row));
	}
	// Expression booléenne utilisée comme valeur.
	return evalBool(expr, row);
}

/**
 * Coercion runtime pour cast(x as T). STRICTES : pas de coercion truthy JS pour
 * bool (parité PG stricte — `'false'` ne devient JAMAIS `false` silencieusement,
 * ce qui divergerait de PG et de Mongo `$convert to:'bool'` truthy). Les targets
 * `date`/`timestamp`/`json` sont refusés — le planner Capabilities.castTargets
 * KV les filtre déjà, arriver ici = bug de synchronisation.
 */
function castValue(target: CastTarget, x: unknown): unknown {
	switch (target) {
		case "int": {
			const n = Number(x);
			if (!Number.isFinite(n)) {
				throw new SnqlError(
					`cast(_ as int) : valeur non convertible '${String(x)}'`,
					"runtime_cast_invalid"
				);
			}
			return Math.trunc(n);
		}
		case "float": {
			const n = Number(x);
			if (!Number.isFinite(n)) {
				throw new SnqlError(
					`cast(_ as float) : valeur non convertible '${String(x)}'`,
					"runtime_cast_invalid"
				);
			}
			return n;
		}
		case "text":
			return String(x);
		case "bool":
			if (typeof x === "boolean") return x;
			throw new SnqlError(
				`cast(_ as bool) : attendu boolean, reçu '${typeof x}' — pas de coercion truthy (parité PG stricte)`,
				"runtime_cast_invalid"
			);
		case "date":
		case "timestamp":
		case "json":
			throw new SnqlError(
				`cast(_ as ${target}) non supporté au runtime KV — bug de synchronisation Capabilities`,
				"runtime_cast_unsupported"
			);
	}
}

/**
 * Arithmétique 3VL : NULL/undefined propage à null (parité SQL). Division/modulo
 * par zéro → null (préserve la sémantique tolérante côté PG qui utilise NULL
 * plutôt qu'une erreur — la division par 0 SQL brute lève, mais notre runtime
 * KV s'aligne sur le comportement le moins destructif).
 */
function evalArith(op: "+" | "-" | "*" | "/" | "%", left: unknown, right: unknown): unknown {
	if (left === null || left === undefined || right === null || right === undefined) {
		return null;
	}
	const l = Number(left);
	const r = Number(right);
	if (!Number.isFinite(l) || !Number.isFinite(r)) {
		return null;
	}
	switch (op) {
		case "+": return l + r;
		case "-": return l - r;
		case "*": return l * r;
		case "/": return r === 0 ? null : l / r;
		case "%": return r === 0 ? null : l % r;
	}
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
		case "arith":
		case "call":
		case "cast":
		case "object":
		case "array":
		case "case":
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
		out[key] = field.expr !== undefined
			? evalValue(field.expr, row)
			: getPath(row, field.path);
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

const INTEGER_STRING = /^-?\d+$/;

/** Chaîne numérique → valeur : entier exact en bigint, flottant en number ; sinon null. */
function numericString(value: unknown): number | bigint | null {
	if (typeof value !== "string") {
		return null;
	}
	const trimmed = value.trim();
	if (trimmed === "") {
		return null;
	}
	if (INTEGER_STRING.test(trimmed)) {
		return BigInt(trimmed); // entier exact, sans perte de précision
	}
	const n = Number(trimmed);
	return Number.isNaN(n) ? null : n;
}

/**
 * Valeur numérique (number, bigint, ou chaîne numérique), sinon null.
 * On NE convertit PAS le bigint en Number (perte > 2^53) : les opérateurs `<`/`>`
 * de JS comparent number et bigint de façon exacte, y compris en cross-type.
 */
function numericOf(value: unknown): number | bigint | null {
	if (typeof value === "number") {
		return Number.isNaN(value) ? null : value;
	}
	if (typeof value === "bigint") {
		return value;
	}
	// Décimal exact → number pour la comparaison en mémoire (JS n'a pas de BigDecimal).
	if (isSqlDecimal(value)) {
		return Number(value.raw);
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
	// Sprint object-literals : deep equal ordre-insensitive pour object/array
	// literals cross-engine (canoniquement PG jsonb réordonne, Mongo compare
	// strict — SNQL harmonise sur ordre-insensitive pour éviter le bug
	// silencieux catastrophique `remove where meta = {n:1}` qui supprime tout
	// via `String(obj) === '[object Object]'` du fallback).
	if (isPlainObject(a) && isPlainObject(b)) {
		return deepEqualObjects(a, b) ? 0 : 1;
	}
	if (Array.isArray(a) && Array.isArray(b)) {
		return deepEqualArrays(a, b) ? 0 : 1;
	}
	const sa = String(a);
	const sb = String(b);
	return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return (
		typeof v === "object" &&
		v !== null &&
		!Array.isArray(v) &&
		Object.getPrototypeOf(v) === Object.prototype
	);
}

function deepEqualObjects(
	a: Record<string, unknown>,
	b: Record<string, unknown>
): boolean {
	const aKeys = Object.keys(a);
	const bKeys = Object.keys(b);
	if (aKeys.length !== bKeys.length) return false;
	for (const key of aKeys) {
		if (!Object.hasOwn(b, key)) return false;
		if (compareValues(a[key], b[key]) !== 0) return false;
	}
	return true;
}

function deepEqualArrays(a: readonly unknown[], b: readonly unknown[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i += 1) {
		if (compareValues(a[i], b[i]) !== 0) return false;
	}
	return true;
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
