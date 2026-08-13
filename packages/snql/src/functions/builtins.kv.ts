/**
 * Renderers KV (in-memory runtime `compensate.ts`) pour les builtins SNQL —
 * sprint T2/5 : introduction du dispatch registre côté KV pour
 * if/nullif/greatest/least. Les fns antérieures restent inline dans
 * `compensate.ts` (migration progressive).
 *
 * Contrat : chaque renderer reçoit les args PlanExpr opaques + un ctx dont
 * `renderExpr` évalue un PlanExpr vers sa valeur runtime pour la row
 * courante. Le renderer choisit lui-même quels args évaluer (short-circuit
 * possible pour `if` — jamais eval simultanément then et else).
 */

import type { EngineRenderer } from "./registry";

/**
 * `if(cond, then, else)` — short-circuit strict. `cond` doit être bool
 * (parité PG `CASE WHEN`) ; null/undefined → else (3VL SQL, null n'est pas
 * "truthy"). Retourne `then` ssi cond === true STRICT.
 */
export const kvIf: EngineRenderer = (args, ctx) => {
	const cond = ctx.renderExpr(args[0]);
	if (cond === true) return ctx.renderExpr(args[1]);
	// null/false/undefined/0/etc → else (parité PG stricte, pas de truthy JS).
	return ctx.renderExpr(args[2]);
};

/**
 * `nullif(a, b)` → null si a === b (égalité stricte SNQL), sinon a.
 * `a` évalué une seule fois — pas de double dispatch inutile.
 */
export const kvNullif: EngineRenderer = (args, ctx) => {
	const a = ctx.renderExpr(args[0]);
	const b = ctx.renderExpr(args[1]);
	// null-safe : nullif(null, null) → null (PG : NULL = NULL est NULL, donc
	// NULLIF ne matche pas et retourne a=NULL — cohérent).
	if (a === null || a === undefined) return null;
	if (b === null || b === undefined) return a;
	return a === b ? null : a;
};

/**
 * `greatest(a, b, …)` — NULL-absorb parité PG : si un arg est null/undefined,
 * retourne null (pas d'ignore comme aggregate max). Éval fold left.
 */
export const kvGreatest: EngineRenderer = (args, ctx) => {
	return foldMinMax(args, ctx, "greatest");
};

/** `least(a, b, …)` — miroir de greatest, avec `<` au lieu de `>`. */
export const kvLeast: EngineRenderer = (args, ctx) => {
	return foldMinMax(args, ctx, "least");
};

function foldMinMax(
	args: readonly unknown[],
	ctx: { renderExpr: (e: unknown) => unknown },
	mode: "greatest" | "least"
): unknown {
	let acc: unknown = ctx.renderExpr(args[0]);
	if (acc === null || acc === undefined) return null;
	for (let i = 1; i < args.length; i += 1) {
		const next = ctx.renderExpr(args[i]);
		if (next === null || next === undefined) return null;
		if (mode === "greatest" && compareLoose(next, acc) > 0) acc = next;
		if (mode === "least" && compareLoose(next, acc) < 0) acc = next;
	}
	return acc;
}

/**
 * Comparaison numeric-first, sinon lex sur String — parité avec `evalCompare`
 * de compensate. Assume valeurs non-null (garde en amont).
 */
function compareLoose(a: unknown, b: unknown): number {
	const na = Number(a);
	const nb = Number(b);
	if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
	const sa = String(a);
	const sb = String(b);
	return sa < sb ? -1 : sa > sb ? 1 : 0;
}

// ─── sprint T2/6 : aggregates scalaires — fold sur ctx.rows ────────────────
// Ces renderers sont dispatchés depuis le case 'aggregate' du switch compensate.
// Ils lisent ctx.rows (toute la collection) et ctx.evalPerRow (évaluation
// scalar per-row) pour émettre une valeur scalaire aggregée.
//
// NULL parité PG stricte : sum/avg/min/max ignorent les NULL, empty → null.
// count(*) inclut toutes les rows, count(x) exclut les NULL. Choix v6
// (documented divergence) : count retourne `number` via rows.length côté KV
// (parité < 2^53, Mongo idem). PG retourne bigint natif.
//
// `coalesce` a besoin d'un renderer KV pour que scalar-around-agg (E5)
// fonctionne : `coalesce(sum(x), 0)` — le SSA pre-fold produit `sum(x)`
// puis coalesce standard lit le résultat. kvCoalesce ajouté ci-dessous.

function assertKvRows(ctx: {
	rows?: readonly Record<string, unknown>[];
	evalPerRow?: (e: unknown, r: Record<string, unknown>) => unknown;
}): {
	rows: readonly Record<string, unknown>[];
	evalPerRow: (e: unknown, r: Record<string, unknown>) => unknown;
} {
	if (ctx.rows === undefined || ctx.evalPerRow === undefined) {
		throw new Error(
			"KV aggregate renderer appelé hors contexte fold (ctx.rows/evalPerRow absents)"
		);
	}
	return { rows: ctx.rows, evalPerRow: ctx.evalPerRow };
}

/**
 * `count(*)` → `rows.length` (Number).
 * `count(x)` → non-null count via evalPerRow (Number).
 * `count(unique x)` → new Set(non-null values).size.
 */
export const kvCount: EngineRenderer = (args, ctx) => {
	const { rows, evalPerRow } = assertKvRows(ctx);
	if (ctx.star === true) return rows.length;
	const arg = args[0];
	if (ctx.unique === true) {
		const seen = new Set<unknown>();
		for (const row of rows) {
			const v = evalPerRow(arg, row);
			if (v !== null && v !== undefined) seen.add(v);
		}
		return seen.size;
	}
	let n = 0;
	for (const row of rows) {
		const v = evalPerRow(arg, row);
		if (v !== null && v !== undefined) n += 1;
	}
	return n;
};

/**
 * `sum(x)` — fold Number sur non-null. Empty (post-filter NULL) → null
 * (parité PG SUM(empty)=NULL). BigInt/decimal ramenés à Number pour rester
 * arithmétiquement homogènes avec avg (KV n'a pas de decimal exact).
 */
export const kvSum: EngineRenderer = (args, ctx) => {
	const { rows, evalPerRow } = assertKvRows(ctx);
	const arg = args[0];
	let sum = 0;
	let hasAny = false;
	for (const row of rows) {
		const v = evalPerRow(arg, row);
		if (v === null || v === undefined) continue;
		const n = Number(v);
		if (Number.isFinite(n)) {
			sum += n;
			hasAny = true;
		}
	}
	return hasAny ? sum : null;
};

/**
 * `avg(x)` — sum(non-null) / count(non-null). Empty → null (parité PG
 * AVG(empty)=NULL). Retour Number (float).
 */
export const kvAvg: EngineRenderer = (args, ctx) => {
	const { rows, evalPerRow } = assertKvRows(ctx);
	const arg = args[0];
	let sum = 0;
	let count = 0;
	for (const row of rows) {
		const v = evalPerRow(arg, row);
		if (v === null || v === undefined) continue;
		const n = Number(v);
		if (Number.isFinite(n)) {
			sum += n;
			count += 1;
		}
	}
	return count > 0 ? sum / count : null;
};

/**
 * `min(x)` — fold via compareLoose. NULL ignore. Empty → null.
 * (Contrairement à `least` qui est NULL-absorb PG-parity.)
 */
export const kvMin: EngineRenderer = (args, ctx) => {
	const { rows, evalPerRow } = assertKvRows(ctx);
	const arg = args[0];
	let acc: unknown = null;
	let hasAny = false;
	for (const row of rows) {
		const v = evalPerRow(arg, row);
		if (v === null || v === undefined) continue;
		if (!hasAny || compareLoose(v, acc) < 0) acc = v;
		hasAny = true;
	}
	return hasAny ? acc : null;
};

/** `max(x)` — miroir de min. */
export const kvMax: EngineRenderer = (args, ctx) => {
	const { rows, evalPerRow } = assertKvRows(ctx);
	const arg = args[0];
	let acc: unknown = null;
	let hasAny = false;
	for (const row of rows) {
		const v = evalPerRow(arg, row);
		if (v === null || v === undefined) continue;
		if (!hasAny || compareLoose(v, acc) > 0) acc = v;
		hasAny = true;
	}
	return hasAny ? acc : null;
};

// ─── sprint T2/6 : kvCoalesce (débloque scalar-around-agg côté KV) ─────────

/**
 * `coalesce(a, b, …)` — retourne le premier arg non-null. Sémantique 'custom'
 * (parité PG COALESCE : null ssi TOUS args null). Ajouté sprint T2/6 pour
 * débloquer `coalesce(sum(x), 0)` côté runtime KV — sinon
 * planner.assertFunctionsSupported rejette coalesce sur KV. Migration inline
 * → registre.
 */
export const kvCoalesce: EngineRenderer = (args, ctx) => {
	for (const arg of args) {
		const v = ctx.renderExpr(arg);
		if (v !== null && v !== undefined) return v;
	}
	return null;
};
