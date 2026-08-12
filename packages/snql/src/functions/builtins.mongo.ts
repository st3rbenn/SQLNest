/**
 * Renderers MongoDB pour les 8 builtins SNQL sprint 1. Les args passés sont des
 * `PlanExpr` opaques (unknown) — le codegen les convertit en opérandes BSON via
 * `ctx.renderExpr` (qui appelle `toExprOperand`).
 */

import type { EngineRenderer } from "./registry";

function renderArgs(args: readonly unknown[], ctx: { renderExpr: (e: unknown) => unknown }): unknown[] {
	return args.map((a) => ctx.renderExpr(a));
}

/** `upper(t)` → `{ $toUpper: <t> }` */
export const mongoUpper: EngineRenderer = (args, ctx) => {
	const [a] = renderArgs(args, ctx);
	return { $toUpper: a };
};

/** `lower(t)` → `{ $toLower: <t> }` */
export const mongoLower: EngineRenderer = (args, ctx) => {
	const [a] = renderArgs(args, ctx);
	return { $toLower: a };
};

/** `length(t)` → `{ $strLenCP: <t> }` — nb de code points, aligné sur PG char_length. */
export const mongoLength: EngineRenderer = (args, ctx) => {
	const [a] = renderArgs(args, ctx);
	return { $strLenCP: a };
};

/** `abs(n)` → `{ $abs: <n> }` */
export const mongoAbs: EngineRenderer = (args, ctx) => {
	const [a] = renderArgs(args, ctx);
	return { $abs: a };
};

/**
 * `round(n)` / `round(n, digits)` → `{ $round: [<n>] }` / `{ $round: [<n>, <d>] }`.
 * `$round` Mongo accepte un array 1-2 éléments — même sémantique de digits que PG.
 */
export const mongoRound: EngineRenderer = (args, ctx) => {
	const rendered = renderArgs(args, ctx);
	return { $round: rendered };
};

/** `coalesce(a, b, …)` → `{ $ifNull: [a, b, …] }` — Mongo 5.0+ accepte n args. */
export const mongoCoalesce: EngineRenderer = (args, ctx) => {
	const rendered = renderArgs(args, ctx);
	return { $ifNull: rendered };
};

/**
 * `now()` → `"$$NOW"` — variable système Mongo (agrégation). Alternative à
 * `new Date()` côté driver, préférée ici car elle reste évaluée côté serveur.
 */
export const mongoNow: EngineRenderer = () => "$$NOW";

/**
 * `concat(a, b, …)` → `{ $concat: [<a>, <b>, …] }` — Mongo propage NULL si un
 * arg est null (comportement diffère de PG.CONCAT qui traite NULL comme "").
 * L'écart est documenté ; T2 sprint 1 assume la sémantique de chaque moteur.
 */
export const mongoConcat: EngineRenderer = (args, ctx) => {
	const rendered = renderArgs(args, ctx);
	return { $concat: rendered };
};
