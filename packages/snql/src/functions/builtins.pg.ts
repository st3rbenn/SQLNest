/**
 * Renderers Postgres pour les 8 builtins SNQL sprint 1. Chaque renderer reçoit
 * les args déjà rendus en SQL (strings) via `ctx.renderExpr` — c'est du string
 * assembly typé côté engine.
 */

import type { EngineRenderer } from "./registry";

/**
 * Petit helper : les args passés au renderer sont des `PlanExpr` opaques (unknown)
 * — le codegen les convertit en SQL via `ctx.renderExpr`. On force le typage ici
 * pour ne pas polluer les signatures.
 */
function renderArgs(args: readonly unknown[], ctx: { renderExpr: (e: unknown) => unknown }): string[] {
	return args.map((a) => ctx.renderExpr(a) as string);
}

/** `upper(t)` → `UPPER(<t>)` */
export const pgUpper: EngineRenderer = (args, ctx) => {
	const [a] = renderArgs(args, ctx);
	return `UPPER(${a})`;
};

/** `lower(t)` → `LOWER(<t>)` */
export const pgLower: EngineRenderer = (args, ctx) => {
	const [a] = renderArgs(args, ctx);
	return `LOWER(${a})`;
};

/** `length(t)` → `LENGTH(<t>)` — nb de caractères (pas d'octets). */
export const pgLength: EngineRenderer = (args, ctx) => {
	const [a] = renderArgs(args, ctx);
	return `LENGTH(${a})`;
};

/** `abs(n)` → `ABS(<n>)` */
export const pgAbs: EngineRenderer = (args, ctx) => {
	const [a] = renderArgs(args, ctx);
	return `ABS(${a})`;
};

/**
 * `round(n)` / `round(n, digits)` → `ROUND(<n>)` / `ROUND(<n>, <d>)`.
 * PG exige un `numeric` pour la forme à 2 args ; le paramétrage laisse
 * PG faire le cast implicite (comportement documenté du driver).
 */
export const pgRound: EngineRenderer = (args, ctx) => {
	const rendered = renderArgs(args, ctx);
	return rendered.length === 1
		? `ROUND(${rendered[0]})`
		: `ROUND(${rendered[0]}, ${rendered[1]})`;
};

/** `coalesce(a, b, …)` → `COALESCE(<a>, <b>, …)` — variadic min 2. */
export const pgCoalesce: EngineRenderer = (args, ctx) => {
	const rendered = renderArgs(args, ctx);
	return `COALESCE(${rendered.join(", ")})`;
};

/** `now()` → `NOW()` — 0 arg, timestamp courant avec fuseau. */
export const pgNow: EngineRenderer = () => "NOW()";

/**
 * `concat(a, b, …)` → `CONCAT(<a>::text, <b>::text, …)` — variadic min 1.
 * Cast explicite `::text` sur chaque arg : `CONCAT` PG est polymorphique
 * (n'importe quel type accepté), donc PG ne peut pas inférer le type d'un
 * paramètre bindé sans indice → erreur `42P18 indeterminate datatype`. Le cast
 * force le type texte côté SQL, ce que fait PG en interne de toute façon.
 */
export const pgConcat: EngineRenderer = (args, ctx) => {
	const rendered = renderArgs(args, ctx);
	return `CONCAT(${rendered.map((a) => `${a}::text`).join(", ")})`;
};
