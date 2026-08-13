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
