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
	for (let i = 0; i < ops.length; i += 1) {
		const op = ops[i]!;
		switch (op.op) {
			case "filter":
				out = out.filter((row) => evalBool(op.predicate, row) === true);
				break;
			case "project": {
				// si des windowCalls dans project.fields, préciser
				// leurs valeurs par row (bucket partition + sort + assign
				// row_number/rank/dense_rank), injecter comme fields dans les
				// rows, puis projectRow les lit comme valeurs déjà résolues.
				const preprocessed = preprocessWindowCalls(op.fields, out);
				out = preprocessed.rows.map((row) =>
					projectRow(row, op.fields, preprocessed.windowSlots)
				);
				// DISTINCT / DISTINCT ON post-projection. Look-ahead
				// vers le sort suivant : PG DISTINCT ON dédup APRÈS ORDER BY,
				// donc on doit trier AVANT de dédup pour parité. Le lower a
				// validé que le sort prefix matche distinctOnKeys.
				if (op.unique === true || op.distinctOnKeys !== undefined) {
					const nextOp = ops[i + 1];
					if (nextOp?.op === "sort" && op.distinctOnKeys !== undefined) {
						out = sortRows(out, nextOp.keys);
					}
					out = applyDistinct(out, op);
				}
				break;
			}
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
			case "aggregate": {
				// fold sur toute la collection → 1 row output.
				// groupKeys peuplé → bucket par clés puis fold
				// chaque bucket ; having filtre les buckets output.
				out = op.groupKeys !== undefined
					? bucketFoldAggregate(op.fields, op.groupKeys, op.having, out)
					: [foldAggregate(op.fields, out)];
				break;
			}
		}
	}
	return out;
}

interface JoinOp {
	readonly collection: string;
	readonly as: string;
	readonly localField: readonly string[];
	readonly foreignField: readonly string[];
	readonly kind?: "join" | "embed" | "count";
}

/**
 * Compensation d'un join. Deux sémantiques :
 *  - `kind: "embed"` (défaut historique 1-to-many) : indexe le right par
 *    foreignField, attache l'array de matchs sous `as` — 1 row par LEFT row.
 *  - `kind: "join"` (many-to-one/one-to-one, LEFT JOIN Mongo natif via
 *    `$lookup + $unwind{preserveNullAndEmptyArrays:true}`) : produit N rows
 *    par LEFT row (cartesian), garde le LEFT si aucun match avec `as: undefined`.
 * Câblé pour honorer la sémantique join↔real coll matérialisée.
 */
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
			continue;
		}
		const bucket = index.get(key);
		if (bucket === undefined) {
			index.set(key, [row]);
		} else {
			bucket.push(row);
		}
	}
	if (op.kind === "join") {
		return left.flatMap((row) => {
			const key = joinKey(getPath(row, op.localField));
			const matched = key !== null ? (index.get(key) ?? []) : [];
			if (matched.length === 0) {
				return [{ ...row, [op.as]: undefined }];
			}
			return matched.map((rightRow) => ({ ...row, [op.as]: rightRow }));
		});
	}
	if (op.kind === "count") {
		// Reverse-nav (ADR-031 D7) : `as` = count scalaire des lignes droites.
		return left.map((row) => {
			const key = joinKey(getPath(row, op.localField));
			const matched = key !== null ? (index.get(key) ?? []) : [];
			return { ...row, [op.as]: matched.length };
		});
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
		// dispatch registre KV. Si l'entrée expose un renderer
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
		// short-circuit strict. Chaque cond évaluée dans l'ordre,
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
	if (expr.kind === "windowCall") {
		// defense-in-depth — les windowCalls sont pre-processed
		// par preprocessWindowCalls avant projectRow ; arriver ici = bug de
		// sync codegen/runtime (windowCall dans un contexte non-project).
		throw new SnqlError(
			`Runtime KV : windowCall '${expr.name}' rencontré hors project — bug lower/planner (les window fns sont refusées ailleurs)`,
			"runtime_window_out_of_project"
		);
	}
	if (expr.kind === "subquery" || expr.kind === "exists") {
		// sub-queries refusées au planner (KV n'a pas la
		// capability). Defense — jamais atteint normalement.
		throw new SnqlError(
			`Runtime KV : sub-query rencontrée — planner_subquery_unsupported attendu avant (bug de sync)`,
			"runtime_subquery_unsupported"
		);
	}
	if (expr.kind === "upsertNew") {
		// upsert refusé au planner (KV n'a pas la capability
		// upsert). Defense — jamais atteint normalement.
		throw new SnqlError(
			`Runtime KV : 'new.<col>' rencontré — capability 'upsert' absente (bug de sync)`,
			"runtime_upsert_unsupported"
		);
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
		case "windowCall":
		case "subquery":
		case "exists":
		case "upsertNew":
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

// --- aggregate fold ------------------------------------------

/**
 * Fold sur toute la collection → 1 row output. Chaque field.expr est évalué
 * via evalAggregateExpr qui dispatch les aggregates (renderer KV avec ctx.rows
 * + ctx.evalPerRow) et les scalar wrappers (récursion standard).
 */
function foldAggregate(
	fields: readonly PlanProjectField[],
	rows: readonly Row[]
): Row {
	const out: Row = {};
	for (const field of fields) {
		const aliasName =
			(field.alias ?? field.path[field.path.length - 1] ?? "") as string;
		if (field.expr !== undefined) {
			out[aliasName] = evalAggregateExpr(field.expr, rows);
		} else {
			throw new SnqlError(
				`Field bare '${field.path.join(".")}' dans pick agg — bug lower/runtime sync`,
				"runtime_agg_bare_field"
			);
		}
	}
	return out;
}

/**
 * bucket rows par groupKeys, fold chaque bucket, applique
 * having (si présent), retourne les rows passantes.
 *
 * Clé bucket = `JSON.stringify(keyValues)` — stable et distingue
 * `null`/`""`/`0`. Une row avec toutes ses group-key values undefined tombe
 * dans le bucket "all-null", cohérent avec PG (NULL values group ensemble).
 *
 * Field bare dans pick matchant un group key → valeur directe depuis la 1re
 * row du bucket (toutes les rows du bucket partagent la même valeur par
 * définition du bucket).
 */
function bucketFoldAggregate(
	fields: readonly PlanProjectField[],
	groupKeys: readonly (readonly string[])[],
	having: PlanExpr | undefined,
	rows: readonly Row[]
): Row[] {
	// Bucket rows par clé JSON-stringify.
	const buckets = new Map<string, Row[]>();
	const keyValuesByBucket = new Map<string, unknown[]>();
	for (const row of rows) {
		const keyValues = groupKeys.map((k) => getPath(row, k));
		const bucketKey = JSON.stringify(keyValues, (_, v) =>
			typeof v === "bigint" ? `__bi:${v.toString()}` : v
		);
		let bucket = buckets.get(bucketKey);
		if (bucket === undefined) {
			bucket = [];
			buckets.set(bucketKey, bucket);
			keyValuesByBucket.set(bucketKey, keyValues);
		}
		bucket.push(row);
	}
	// Fold + having chaque bucket.
	const out: Row[] = [];
	// Group key last segments — pour resolver les path-only fields.
	const groupKeyLastSegs = new Map<string, readonly string[]>();
	for (const k of groupKeys) {
		const last = k[k.length - 1];
		if (last !== undefined) groupKeyLastSegs.set(last, k);
	}
	for (const [bucketKey, bucketRows] of buckets) {
		const foldedRow: Row = {};
		const firstRow = bucketRows[0] as Row;
		for (const field of fields) {
			const aliasName =
				(field.alias ?? field.path[field.path.length - 1] ?? "") as string;
			if (field.expr !== undefined) {
				foldedRow[aliasName] = evalAggregateExpr(field.expr, bucketRows, firstRow);
			} else if (field.path.length > 0) {
				// Path-only field = group key (validé lower). Lookup direct
				// depuis 1re row du bucket.
				const lastSeg = field.path[field.path.length - 1] as string;
				if (groupKeyLastSegs.has(lastSeg)) {
					foldedRow[aliasName] = getPath(bucketRows[0] as Row, groupKeyLastSegs.get(lastSeg)!);
				} else {
					throw new SnqlError(
						`Field bare '${field.path.join(".")}' dans pick agg group — bug lower/runtime sync`,
						"runtime_agg_bare_field"
					);
				}
			}
		}
		// Having filter — évalué via evalAggregateExpr contre bucketRows.
		// Field bare refs matchant un group key → résolus depuis la 1re row du
		// bucket (toutes les rows du bucket partagent la même valeur).
		if (having !== undefined) {
			const havingResult = evalAggregateExpr(
				having,
				bucketRows,
				bucketRows[0] as Row
			);
			if (havingResult !== true) continue;
		}
		void bucketKey;
		out.push(foldedRow);
	}
	return out;
}

/**
 * Évalue un PlanExpr dans le contexte d'un pick agg. Les aggregate calls
 * délèguent au renderer KV avec ctx.rows/evalPerRow. Les scalar wrappers
 * (coalesce/if/case/arith/…) descendent via evalAggregateExpr — nested
 * aggregates auraient été refusés au lower (lower_agg_nested).
 */
function evalAggregateExpr(
	expr: PlanExpr,
	rows: readonly Row[],
	groupKeyRow?: Row
): unknown {
	if (expr.kind === "call") {
		const entry = SNQL_FUNCTIONS.get(expr.name);
		if (entry?.engines.kv === undefined) {
			throw new Error(
				`Runtime KV : fonction '${expr.name}' non exécutable (planner devrait avoir rejeté)`
			);
		}
		if (entry.kind === "aggregate" || entry.kind === "aggregateMulti") {
			return entry.engines.kv(expr.args, {
				// renderExpr pour aggregateMulti sert à évaluer le
				// literal `sep` de string_agg (via evalValue direct — pas de row).
				// Pour les scalaires wrappés, on descend via evalAggregateExpr.
				renderExpr: (a) =>
					entry.kind === "aggregateMulti"
						? evalValue(a as PlanExpr, groupKeyRow ?? ({} as Row))
						: evalAggregateExpr(a as PlanExpr, rows, groupKeyRow),
				rows,
				evalPerRow: (a, r) => evalValue(a as PlanExpr, r as Row),
				...(expr.star === true ? { star: true } : {}),
				...(expr.unique === true ? { unique: true } : {}),
				// sortKeys propagé pour aggregateMulti (kvArrayAgg
				// & co l'utilisent pour trier avant collecte).
				...(expr.sortKeys !== undefined && expr.sortKeys.length > 0
					? { sortKeys: expr.sortKeys }
					: {})
			});
		}
		return entry.engines.kv(expr.args, {
			renderExpr: (a) => evalAggregateExpr(a as PlanExpr, rows, groupKeyRow)
		});
	}
	if (expr.kind === "literal") return expr.value;
	if (expr.kind === "field") {
		// field bare dans having ou dans pick.expr peut référencer
		// une group key — dans ce cas on résout via groupKeyRow (toutes les rows
		// du bucket partagent la même valeur).
		if (groupKeyRow !== undefined) {
			return getPath(groupKeyRow, expr.path);
		}
		throw new SnqlError(
			`Field bare '${expr.path.join(".")}' dans pick agg — bug lower/runtime sync`,
			"runtime_agg_bare_field"
		);
	}
	if (expr.kind === "arith") {
		return evalArith(
			expr.op,
			evalAggregateExpr(expr.left, rows, groupKeyRow),
			evalAggregateExpr(expr.right, rows, groupKeyRow)
		);
	}
	if (expr.kind === "cast") {
		const inner = evalAggregateExpr(expr.operand, rows, groupKeyRow);
		if (inner === null || inner === undefined) return null;
		return castValue(expr.target, inner);
	}
	if (expr.kind === "object") {
		const out: Record<string, unknown> = {};
		for (const e of expr.entries) out[e.key] = evalAggregateExpr(e.value, rows, groupKeyRow);
		return out;
	}
	if (expr.kind === "array") {
		return expr.items.map((i) => evalAggregateExpr(i, rows, groupKeyRow));
	}
	if (expr.kind === "case") {
		for (const b of expr.branches) {
			const cond = evalAggregateExpr(b.cond, rows, groupKeyRow);
			if (cond === true) return evalAggregateExpr(b.value, rows, groupKeyRow);
		}
		return evalAggregateExpr(expr.elseValue, rows, groupKeyRow);
	}
	if (expr.kind === "compare") {
		return evalCompare(
			expr.op,
			evalAggregateExpr(expr.left, rows, groupKeyRow),
			evalAggregateExpr(expr.right, rows, groupKeyRow)
		);
	}
	if (expr.kind === "and") {
		return and3(
			coerceBool(evalAggregateExpr(expr.left, rows, groupKeyRow)),
			coerceBool(evalAggregateExpr(expr.right, rows, groupKeyRow))
		);
	}
	if (expr.kind === "or") {
		return or3(
			coerceBool(evalAggregateExpr(expr.left, rows, groupKeyRow)),
			coerceBool(evalAggregateExpr(expr.right, rows, groupKeyRow))
		);
	}
	if (expr.kind === "not") {
		const inner = coerceBool(evalAggregateExpr(expr.operand, rows, groupKeyRow));
		return inner === null ? null : !inner;
	}
	if (expr.kind === "isNull") {
		const inner = evalAggregateExpr(expr.operand, rows, groupKeyRow);
		const missing = inner === null || inner === undefined;
		return expr.negated ? !missing : missing;
	}
	if (expr.kind === "in") {
		return evalIn(
			evalAggregateExpr(expr.target, rows, groupKeyRow),
			expr.values.map((v) => evalAggregateExpr(v, rows, groupKeyRow))
		);
	}
	throw new SnqlError(
		"Expression non supportée dans un pick agg (bug de sync)",
		"runtime_agg_expr"
	);
}

// --- Projection / tri / accès ---

function projectRow(
	row: Row,
	fields: readonly PlanProjectField[],
	windowSlots?: Map<string, string>
): Row {
	const out: Row = {};
	for (const field of fields) {
		const key = field.alias ?? field.path[field.path.length - 1] ?? "";
		if (field.expr?.kind === "windowCall" && windowSlots !== undefined) {
			const slot = windowSlots.get(windowCallKvKey(field.expr));
			if (slot !== undefined) {
				out[key] = row[slot];
				continue;
			}
		}
		out[key] = field.expr !== undefined
			? evalValue(field.expr, row)
			: getPath(row, field.path);
	}
	return out;
}

/**
 * clé stable pour dédup les windowCalls identiques côté KV.
 * Miroir de `windowCallKey` dans mongodb.ts.
 */
function windowCallKvKey(expr: PlanExpr & { kind: "windowCall" }): string {
	return JSON.stringify({
		n: expr.name,
		p: expr.partitionKeys,
		s: expr.sortKeys.map((k) => ({ p: k.path, d: k.direction }))
	});
}

/**
 * pre-processing des windowCalls dans un project. Pour chaque
 * windowCall unique (par name+partition+sort) :
 *  1. Bucket les rows par partition keys (JSON.stringify).
 *  2. Sort chaque bucket par sortKeys.
 *  3. Assign row_number/rank/dense_rank per row → écrit sur un slot
 *     `__win_N` du row cloné.
 *  4. Reconstitue l'ordre original des rows (préserve la stabilité — le
 *     project ne réordonne pas, seuls les windows lisent l'ordre par
 *     partition).
 *
 * Retourne les rows enrichies + slotByKey pour projectRow.
 */
/**
 * applique DISTINCT / DISTINCT ON sur les rows post-projection.
 *
 * - `unique` seul : dédup via canonicalKey sur tous les fields output,
 *   preserving order (Set-based, 1re occurrence conservée).
 * - `distinctOnKeys` : bucket par les keys, garde la 1re row de chaque
 *   bucket (parité PG DISTINCT ON — l'ordre du sort en amont détermine
 *   "first", check prefix-match au lower).
 */
function applyDistinct(
	rows: readonly Row[],
	op: { unique?: true; distinctOnKeys?: readonly (readonly string[])[] }
): Row[] {
	if (op.distinctOnKeys !== undefined && op.distinctOnKeys.length > 0) {
		const seen = new Set<string>();
		const out: Row[] = [];
		for (const row of rows) {
			// Key path = dernier segment (post-projection les fields sont top).
			const keyValues = op.distinctOnKeys.map((k) => {
				const lastSeg = k[k.length - 1] as string;
				return row[lastSeg];
			});
			const key = JSON.stringify(keyValues, (_, v) =>
				typeof v === "bigint" ? `__bi:${v.toString()}` : v
			);
			if (seen.has(key)) continue;
			seen.add(key);
			out.push(row);
		}
		return out;
	}
	// DISTINCT sur toute la row (post-projection).
	const seen = new Set<string>();
	const out: Row[] = [];
	for (const row of rows) {
		const key = JSON.stringify(row, (_, v) =>
			typeof v === "bigint" ? `__bi:${v.toString()}` : v
		);
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(row);
	}
	return out;
}

function preprocessWindowCalls(
	fields: readonly PlanProjectField[],
	rows: readonly Row[]
): { rows: Row[]; windowSlots: Map<string, string> | undefined } {
	const windowCalls: (PlanExpr & { kind: "windowCall" })[] = [];
	const slotByKey = new Map<string, string>();
	let slotCounter = 0;
	for (const field of fields) {
		if (field.expr?.kind !== "windowCall") continue;
		const key = windowCallKvKey(field.expr);
		if (slotByKey.has(key)) continue;
		slotByKey.set(key, `__win_${slotCounter}`);
		windowCalls.push(field.expr);
		slotCounter += 1;
	}
	if (windowCalls.length === 0) {
		return { rows: [...rows], windowSlots: undefined };
	}
	// Clone rows pour ne pas muter l'input compensate.
	const enriched = rows.map((r) => ({ ...r }));
	for (const w of windowCalls) {
		const slot = slotByKey.get(windowCallKvKey(w))!;
		// Bucket par partition keys.
		const buckets = new Map<string, { row: Row; origIdx: number }[]>();
		for (const [origIdx, row] of enriched.entries()) {
			const partKey = JSON.stringify(
				w.partitionKeys.map((p) => getPath(row, p)),
				(_, v) => (typeof v === "bigint" ? `__bi:${v.toString()}` : v)
			);
			let bucket = buckets.get(partKey);
			if (bucket === undefined) {
				bucket = [];
				buckets.set(partKey, bucket);
			}
			bucket.push({ row, origIdx });
		}
		// Pour chaque bucket : sort + assign.
		for (const bucket of buckets.values()) {
			if (w.sortKeys.length > 0) {
				bucket.sort((a, b) => {
					for (const k of w.sortKeys) {
						const va = getPath(a.row, k.path);
						const vb = getPath(b.row, k.path);
						const cmp = compareForSort(va, vb);
						if (cmp !== 0) return k.direction === "desc" ? -cmp : cmp;
					}
					return 0;
				});
			}
			// Assign compute per row du bucket.
			let currentRank = 0;
			let currentDenseRank = 0;
			let prevSortValues: unknown[] | null = null;
			let sameGroupCount = 0;
			for (const [idx, entry] of bucket.entries()) {
				const rowNumber = idx + 1;
				// Check if this row shares sort values with previous (for RANK/DENSE_RANK ties).
				const currentSortValues = w.sortKeys.map((k) => getPath(entry.row, k.path));
				const isSameGroup =
					prevSortValues !== null &&
					w.sortKeys.length > 0 &&
					currentSortValues.every((v, i) => compareForSort(v, prevSortValues![i]) === 0);
				if (!isSameGroup) {
					currentRank = rowNumber;
					currentDenseRank += 1;
					sameGroupCount = 1;
				} else {
					sameGroupCount += 1;
				}
				prevSortValues = currentSortValues;
				let value: number;
				if (w.name === "row_number") value = rowNumber;
				else if (w.name === "rank") value = currentRank;
				else if (w.name === "dense_rank") value = currentDenseRank;
				else {
					throw new Error(
						`Runtime KV : window '${w.name}' non implémenté (+)`
					);
				}
				entry.row[slot] = value;
			}
		}
	}
	return { rows: enriched, windowSlots: slotByKey };
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
