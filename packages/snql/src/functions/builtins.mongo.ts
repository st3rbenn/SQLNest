/**
 * Renderers MongoDB pour les builtins SNQL (sprint 1 : 8 fonctions, sprint 3
 * : +11 fonctions). Les args passés sont des `PlanExpr` opaques (unknown) —
 * le codegen les convertit en opérandes BSON via `ctx.renderExpr`.
 *
 * Baseline Mongo 5.0+ pour $dateTrunc, $dateAdd, $dateDiff, $replaceAll.
 */

import { extractStringLiteralArg } from "./builtins-shared";
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

// ─── sprint 3 : string ─────────────────────────────────────────────────────

/** `trim(s [, chars])` → `{ $trim: { input: <s> [, chars] } }`. */
export const mongoTrim: EngineRenderer = (args, ctx) => {
	const rendered = renderArgs(args, ctx);
	return rendered.length === 1
		? { $trim: { input: rendered[0] } }
		: { $trim: { input: rendered[0], chars: rendered[1] } };
};

/** `ltrim(s [, chars])` → `{ $ltrim: { input: <s> [, chars] } }`. */
export const mongoLtrim: EngineRenderer = (args, ctx) => {
	const rendered = renderArgs(args, ctx);
	return rendered.length === 1
		? { $ltrim: { input: rendered[0] } }
		: { $ltrim: { input: rendered[0], chars: rendered[1] } };
};

/** `rtrim(s [, chars])` → `{ $rtrim: { input: <s> [, chars] } }`. */
export const mongoRtrim: EngineRenderer = (args, ctx) => {
	const rendered = renderArgs(args, ctx);
	return rendered.length === 1
		? { $rtrim: { input: rendered[0] } }
		: { $rtrim: { input: rendered[0], chars: rendered[1] } };
};

/**
 * `substring(s, start, len)` — 1-indexed cross-engine. Mongo `$substrCP` est
 * 0-indexed et renvoie `""` sur null (au lieu de null). Wrap `$let + $cond`
 * pour :
 *  1. propager NULL sur n'importe lequel des 3 args (parité PG)
 *  2. remap start 1-based → 0-based avec `$max` (start négatif ou 0 → 0)
 *  3. garder len non-négative avec `$max` (parité rognage PG)
 * Utilise `$substrCP` (code points, aligné $strLenCP), jamais `$substrBytes`.
 */
export const mongoSubstring: EngineRenderer = (args, ctx) => {
	const [s, start, len] = renderArgs(args, ctx);
	return {
		$let: {
			vars: { s, start, len },
			in: {
				$cond: [
					{
						$or: [
							{ $eq: ["$$s", null] },
							{ $eq: ["$$start", null] },
							{ $eq: ["$$len", null] }
						]
					},
					null,
					{
						$substrCP: [
							"$$s",
							{ $max: [{ $subtract: ["$$start", 1] }, 0] },
							{ $max: ["$$len", 0] }
						]
					}
				]
			}
		}
	};
};

/**
 * `replace(s, from, to)` → `{ $replaceAll: { input, find, replacement } }`.
 * Mongo 4.2+. Littéral pur (jamais regex).
 */
export const mongoReplace: EngineRenderer = (args, ctx) => {
	const [s, from, to] = renderArgs(args, ctx);
	return { $replaceAll: { input: s, find: from, replacement: to } };
};

/**
 * `strpos(haystack, needle)` — 1-indexed cross-engine (0 = absent).
 * Mongo `$indexOfCP` renvoie 0-indexed avec -1 si absent → remap :
 *   -1 → 0 ; N ≥ 0 → N+1.
 */
export const mongoStrpos: EngineRenderer = (args, ctx) => {
	const [h, n] = renderArgs(args, ctx);
	return {
		$let: {
			vars: { p: { $indexOfCP: [h, n] } },
			in: {
				$cond: [{ $eq: ["$$p", -1] }, 0, { $add: ["$$p", 1] }]
			}
		}
	};
};

// ─── sprint 3 : number ─────────────────────────────────────────────────────

/** `floor(n)` → `{ $floor: <n> }`. */
export const mongoFloor: EngineRenderer = (args, ctx) => {
	const [n] = renderArgs(args, ctx);
	return { $floor: n };
};

/** `ceil(n)` → `{ $ceil: <n> }`. */
export const mongoCeil: EngineRenderer = (args, ctx) => {
	const [n] = renderArgs(args, ctx);
	return { $ceil: n };
};

// ─── sprint 3 : date ───────────────────────────────────────────────────────

/**
 * `today()` → `{ $dateTrunc: { date: '$$NOW', unit: 'day' } }`. Mongo 5.0+.
 * UTC natif (parité avec pgToday qui force UTC via `AT TIME ZONE`).
 */
export const mongoToday: EngineRenderer = () => ({
	$dateTrunc: { date: "$$NOW", unit: "day" }
});

/**
 * `date_part(unit, d)` — switch sur unit vers l'opérateur Mongo dédié.
 * `week` → `$isoWeek` (ISO comme PG). `dow` → `$dayOfWeek - 1` (remap 1-7 → 0-6
 * pour parité PG dim=0). `epoch` → `$toLong(d) / 1000` (ms → sec).
 */
export const mongoDatePart: EngineRenderer = (args, ctx) => {
	const unit = extractStringLiteralArg(args[0], "date_part", 0);
	const d = ctx.renderExpr(args[1]);
	switch (unit) {
		case "year":
			return { $year: d };
		case "quarter":
			return { $quarter: d };
		case "month":
			return { $month: d };
		case "week":
			return { $isoWeek: d };
		case "day":
			return { $dayOfMonth: d };
		case "hour":
			return { $hour: d };
		case "minute":
			return { $minute: d };
		case "second":
			return { $second: d };
		case "dow":
			// $dayOfWeek = 1 (dim) ... 7 (sam) → remap 0..6 (dim=0)
			return { $subtract: [{ $dayOfWeek: d }, 1] };
		case "doy":
			return { $dayOfYear: d };
		case "epoch":
			// $toLong sur Date → ms Unix → /1000 = secondes Unix
			return { $divide: [{ $toLong: d }, 1000] };
		default:
			// argEnum au lower a déjà filtré — defense-in-depth.
			return { $year: d };
	}
};

/**
 * `date_trunc(unit, d)` → `{ $dateTrunc: { date, unit, binSize: 1 } }`.
 * Fix critique week : Mongo default `startOfWeek=sunday` vs PG ISO
 * (lundi) → renderer force `startOfWeek: 'monday'` sur week. Mongo 5.0+.
 */
export const mongoDateTrunc: EngineRenderer = (args, ctx) => {
	const unit = extractStringLiteralArg(args[0], "date_trunc", 0);
	const d = ctx.renderExpr(args[1]);
	const base = { date: d, unit, binSize: 1 };
	return unit === "week"
		? { $dateTrunc: { ...base, startOfWeek: "monday" } }
		: { $dateTrunc: base };
};

/**
 * `date_add(unit, d, amount)` → `{ $dateAdd: { startDate, unit, amount } }`.
 * Mongo 5.0+. Ordre args SNQL unit-first → renderer réordonne pour Mongo.
 * amount peut être négatif (soustraction).
 */
export const mongoDateAdd: EngineRenderer = (args, ctx) => {
	const unit = extractStringLiteralArg(args[0], "date_add", 0);
	const d = ctx.renderExpr(args[1]);
	const amount = ctx.renderExpr(args[2]);
	return { $dateAdd: { startDate: d, unit, amount } };
};

/**
 * `date_diff(unit, later, earlier)` → `{ $dateDiff: { startDate, endDate,
 * unit } }`. Mongo 5.0+. Signature SNQL later-first → renderer swap
 * start/end pour convention Mongo (start=earlier, end=later → résultat positif).
 * Whitelist réduite {day, hour, minute, second} sprint 3.
 */
export const mongoDateDiff: EngineRenderer = (args, ctx) => {
	const unit = extractStringLiteralArg(args[0], "date_diff", 0);
	const later = ctx.renderExpr(args[1]);
	const earlier = ctx.renderExpr(args[2]);
	return { $dateDiff: { startDate: earlier, endDate: later, unit } };
};
