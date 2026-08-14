/**
 * Renderers MongoDB pour les builtins SNQL (sprint 1 : 8 fonctions, sprint 3
 * : +11 fonctions). Les args passés sont des `PlanExpr` opaques (unknown) —
 * le codegen les convertit en opérandes BSON via `ctx.renderExpr`.
 *
 * Baseline Mongo 5.0+ pour $dateTrunc, $dateAdd, $dateDiff, $replaceAll.
 */

import { extractStringLiteralArg } from "./builtins-shared";
import { SnqlError } from "../diagnostics";
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

// ─── sprint 4 : JSON ───────────────────────────────────────────────────────

/**
 * Duck-type un PlanExpr literal pour un segment path JSON. Le lower a déjà
 * validé — le renderer discrimine sur le type de la value pour choisir
 * `$getField` (string key) ou `$arrayElemAt` (int index).
 */
function segmentValue(arg: unknown): string | number {
	const literal = arg as { kind?: unknown; value?: unknown };
	if (literal.kind !== "literal") {
		throw new Error(
			"mongo json path segment : literal attendu (bug lower — guard aurait dû bloquer)"
		);
	}
	const v = literal.value as string | number;
	if (typeof v === "string" || typeof v === "number") return v;
	throw new Error(
		`mongo json path segment : type ${typeof v} inattendu (bug lower)`
	);
}

/**
 * Chain BSON pour un path variadic. Chaque segment string → `$getField`,
 * chaque segment int → `$cond` sur $type='array' + `$arrayElemAt` (parité
 * PG NULL silencieux sur non-array vs Mongo throw sinon). Baseline Mongo 5.0+.
 */
function mongoRenderJsonPathChain(
	args: readonly unknown[],
	ctx: { renderExpr: (e: unknown) => unknown }
): unknown {
	const docExpr = ctx.renderExpr(args[0]);
	// Wrap $ifNull OBLIGATOIRE sur input doc pour parité NULL PG.
	let chain: unknown = { $ifNull: [docExpr, null] };
	for (let i = 1; i < args.length; i += 1) {
		const value = segmentValue(args[i]);
		if (typeof value === "string") {
			chain = { $getField: { field: value, input: chain } };
		} else {
			// Wrap $cond OBLIGATOIRE : sur non-array, $arrayElemAt throw
			// runtime alors que PG `->` retourne NULL silencieux.
			chain = {
				$cond: [
					{ $eq: [{ $type: chain }, "array"] },
					{ $arrayElemAt: [chain, value] },
					null
				]
			};
		}
	}
	return chain;
}

/**
 * `json_get(doc, ...path)` → chain BSON via $getField + $arrayElemAt wrapped.
 * Wrap final `$ifNull` pour uniformiser missing key → null.
 */
export const mongoJsonGet: EngineRenderer = (args, ctx) => {
	const chain = mongoRenderJsonPathChain(args, ctx);
	return { $ifNull: [chain, null] };
};

/**
 * `json_get_text(doc, ...path)` → chain identique + wrap final `$cond` AVANT
 * `$toString` (PIÈGE : `$ifNull:[{$toString:chain}, null]` NE MARCHE PAS car
 * `$toString` throw AVANT que `$ifNull` intervienne sur null). Pattern éprouvé
 * mongoSubstring sprint 3.
 */
export const mongoJsonGetText: EngineRenderer = (args, ctx) => {
	const chain = mongoRenderJsonPathChain(args, ctx);
	return {
		$let: {
			vars: { v: chain },
			in: {
				$cond: [{ $eq: ["$$v", null] }, null, { $toString: "$$v" }]
			}
		}
	};
};

/**
 * `json_has_key(doc, "key")` → `{$ne: [{$type: {$getField: ...}}, 'missing']}`.
 * Wrap `$ifNull:[doc, {}]` OBLIGATOIRE : sans lui, `$getField` sur null input
 * renvoie null, `$type: null` = 'null' ≠ 'missing' → renvoie true silencieux
 * (bug identifié à l'adversarial verify). Avec fallback objet vide,
 * doc null → tous fields → 'missing' → false (parité pragmatique documentée).
 */
export const mongoJsonHasKey: EngineRenderer = (args, ctx) => {
	const docExpr = ctx.renderExpr(args[0]);
	const key = segmentValue(args[1]);
	return {
		$ne: [
			{
				$type: {
					$getField: { field: key, input: { $ifNull: [docExpr, {}] } }
				}
			},
			"missing"
		]
	};
};

/**
 * `json_typeof(doc)` → `$switch` avec remap BSON→JSON canonique. Missing → null,
 * int/long/double/decimal → 'number', bool → 'boolean', array/object
 * identiques, null → 'null'. Types BSON hors JSON (ObjectId/Date/Timestamp/
 * binData) → 'string' (approximation cohérente avec sérialisation drivers,
 * pas de throw runtime sur ObjectId ubiquitaire des _id Mongo).
 */
export const mongoJsonTypeof: EngineRenderer = (args, ctx) => {
	const docExpr = ctx.renderExpr(args[0]);
	return {
		$let: {
			vars: { t: { $type: docExpr } },
			in: {
				$switch: {
					branches: [
						{ case: { $eq: ["$$t", "missing"] }, then: null },
						{
							case: {
								$in: ["$$t", ["int", "long", "double", "decimal"]]
							},
							then: "number"
						},
						{ case: { $eq: ["$$t", "string"] }, then: "string" },
						{ case: { $eq: ["$$t", "bool"] }, then: "boolean" },
						{ case: { $eq: ["$$t", "null"] }, then: "null" },
						{ case: { $eq: ["$$t", "array"] }, then: "array" },
						{ case: { $eq: ["$$t", "object"] }, then: "object" },
						{ case: { $eq: ["$$t", "objectId"] }, then: "string" },
						{ case: { $eq: ["$$t", "date"] }, then: "string" },
						{ case: { $eq: ["$$t", "timestamp"] }, then: "string" },
						{ case: { $eq: ["$$t", "binData"] }, then: "string" }
					],
					default: null
				}
			}
		}
	};
};

// ─── sprint T2/5 : conditional ─────────────────────────────────────────────

/**
 * `if(cond, then, else)` → `{ $cond: [<cond>, <then>, <else>] }`. Sucre 3-arg
 * pour un `case` d'une seule branche. Mongo `$cond` évalue strictement bool
 * sur le premier arg (aligné PG `CASE WHEN cond THEN`).
 */
export const mongoIf: EngineRenderer = (args, ctx) => {
	const [c, t, e] = renderArgs(args, ctx);
	return { $cond: [c, t, e] };
};

/**
 * `nullif(a, b)` → `{ $cond: [{ $eq: [<a>, <b>] }, null, <a>] }`. Pas
 * d'opérateur $nullIf natif en Mongo — l'émulation via $cond est directe.
 * `a` évalué deux fois : côté BSON pipeline pas de side-effect à craindre.
 */
export const mongoNullif: EngineRenderer = (args, ctx) => {
	const [a, b] = renderArgs(args, ctx);
	return { $cond: [{ $eq: [a, b] }, null, a] };
};

/**
 * `greatest(a, b, …)` → émulation via `$reduce` (Option C validée par
 * l'utilisateur, écarte Option D natif `$max`/`$min`).
 *
 * Why : `$max`/`$min` en pipeline (hors accumulator) réduisent sur un array,
 * mais leur sémantique NULL diverge de PG :
 *  - PG `GREATEST` retourne NULL si tous args NULL (NULL-absorb sur mix)
 *  - Mongo `$max` sur `[3, null, 5]` retourne `5` (ignore null, PG-incompat)
 *
 * L'émulation `$reduce` force l'absorbance NULL parité PG :
 *  - Initial value = premier arg
 *  - Chaque étape : `$cond` sur `$eq` value null OU acc null → null,
 *    sinon `$cond` sur `$gt`/`$lt` → sélectionne
 *
 * Coût : légèrement plus lourd que `$max` natif, mais correct sur tous les
 * cas et safe cross-version Mongo (aucune divergence NULL entre releases).
 */
export const mongoGreatest: EngineRenderer = (args, ctx) => {
	const rendered = renderArgs(args, ctx);
	return buildMongoMinMax(rendered, "greatest");
};

export const mongoLeast: EngineRenderer = (args, ctx) => {
	const rendered = renderArgs(args, ctx);
	return buildMongoMinMax(rendered, "least");
};

/**
 * Construit un `$reduce` NULL-absorb parité PG. `mode` détermine l'opérateur
 * de comparaison (`$gt` pour greatest, `$lt` pour least).
 */
function buildMongoMinMax(
	rendered: readonly unknown[],
	mode: "greatest" | "least"
): unknown {
	const cmp = mode === "greatest" ? "$gt" : "$lt";
	const [first, ...rest] = rendered;
	return {
		$reduce: {
			input: rest,
			initialValue: first,
			in: {
				$cond: [
					// NULL-absorb : acc null OU next null → null (parité PG).
					{
						$or: [
							{ $eq: ["$$value", null] },
							{ $eq: ["$$this", null] }
						]
					},
					null,
					{ $cond: [{ [cmp]: ["$$this", "$$value"] }, "$$this", "$$value"] }
				]
			}
		}
	};
}

// ─── sprint T2/6 : aggregates scalaires (accumulators pour $group) ─────────
// Les 5 renderers ci-dessous retournent un ACCUMULATOR body valide uniquement
// dans un stage $group. Le SSA extract (codegen/mongodb.ts) matérialise
// [$group{_id:null,...accs}, $project{_id:0,...renames}] paire pour un
// aggregate op ; c'est à ce moment-là que ces renderers sont invoqués.

/**
 * `count(*)` → `{ $sum: 1 }` (ctx.star).
 * `count(x)` → `{ $sum: {$cond:[{$ne:['$x',null]},1,0]} }` (NULL-ignore parité PG).
 * `count(unique x)` — le SSA extract hardcode le 2-stage ($addToSet + $size)
 * AVANT d'atteindre ce renderer. Si on arrive ici avec ctx.unique=true c'est
 * un bug de synchronisation SSA — throw defense-in-depth.
 */
export const mongoCount: EngineRenderer = (args, ctx) => {
	if (ctx.star === true) return { $sum: 1 };
	if (ctx.unique === true) {
		throw new Error(
			"mongoCount(unique) doit être matérialisé par le SSA extract ($addToSet + $size), pas via le renderer direct"
		);
	}
	const arg = ctx.renderExpr(args[0]);
	return { $sum: { $cond: [{ $ne: [arg, null] }, 1, 0] } };
};

/**
 * `sum(x)` → `{ $sum: '$x' }`. Empty collection → $sum retourne 0 côté Mongo
 * (BSON quirk) vs NULL côté PG — divergence documentée dans knownDivergences.
 * `sum(unique x)` refusé au planner (planner_agg_unique_mongo_unsupported_sum_avg,
 * sprint 6). Defense-in-depth si ctx.unique atteint ce renderer.
 */
export const mongoSum: EngineRenderer = (args, ctx) => {
	if (ctx.unique === true) {
		throw new SnqlError(
			"'sum(unique ...)' non supporté sur mongodb sprint 6 — utilise 'count(unique x)' ou reporte sprint 8 (aggregateMulti 2-stage)",
			"planner_agg_unique_mongo_unsupported_sum_avg"
		);
	}
	const arg = ctx.renderExpr(args[0]);
	return { $sum: arg };
};

/**
 * `avg(x)` → `{ $avg: '$x' }` — double natif Mongo. `avg(unique x)` refusé
 * planner (sprint 6, cf mongoSum).
 */
export const mongoAvg: EngineRenderer = (args, ctx) => {
	if (ctx.unique === true) {
		throw new SnqlError(
			"'avg(unique ...)' non supporté sur mongodb sprint 6 — utilise 'count(unique x)' ou reporte sprint 8 (aggregateMulti 2-stage)",
			"planner_agg_unique_mongo_unsupported_sum_avg"
		);
	}
	const arg = ctx.renderExpr(args[0]);
	return { $avg: arg };
};

/**
 * `min(x)` → `{ $min: '$x' }` — passthrough type BSON. `min(unique x)` refusé
 * au lower (lower_call_unique_no_op_min_max) — le codegen ne devrait jamais
 * voir ctx.unique=true sur min/max.
 */
export const mongoMin: EngineRenderer = (args, ctx) => {
	if (ctx.unique === true) {
		throw new Error(
			"mongoMin(unique) refusé — lower_call_unique_no_op_min_max attendu avant codegen"
		);
	}
	const arg = ctx.renderExpr(args[0]);
	return { $min: arg };
};

export const mongoMax: EngineRenderer = (args, ctx) => {
	if (ctx.unique === true) {
		throw new Error(
			"mongoMax(unique) refusé — lower_call_unique_no_op_min_max attendu avant codegen"
		);
	}
	const arg = ctx.renderExpr(args[0]);
	return { $max: arg };
};

// ─── sprint T2/8 : aggregateMulti ─────────────────────────────────────────

/**
 * Rendu du body accumulateur Mongo pour aggregateMulti — retourne toujours
 * `{$push: <arg>}` en $group. Le sort intra-call + reduce (pour string_agg)
 * sont appliqués en $project via un helper séparé (dispatché par le codegen
 * mongodb.ts qui wrap la valeur du slot).
 *
 * `unique` : la déduplication passe par `{$addToSet: <arg>}` au lieu de $push.
 * Compatibility Mongo native.
 *
 * Le sortKeys est passé au codegen via ctx.sortKeys — le renderer ici renvoie
 * juste l'accumulator body. Le post-processing $sortArray/$reduce est fait
 * par mongodb.ts:renderAggregatePipeline en lisant call.sortKeys directement
 * depuis le PlanExpr.
 */
export const mongoArrayAgg: EngineRenderer = (args, ctx) => {
	const arg = ctx.renderExpr(args[0]);
	// $addToSet dédup pour `unique` ; sinon $push (préserve ordre + doublons).
	return ctx.unique === true ? { $addToSet: arg } : { $push: arg };
};

/**
 * `string_agg(x, sep)` — Mongo n'a pas de STRING_AGG natif. On accumule via
 * `$push` en $group (préserve ordre) puis $reduce en $project pour concat
 * avec sep. Le renderer retourne le body accumulator ; le codegen wrap le
 * $reduce en post-processing (accès à sep + sort).
 *
 * Sémantique NULL : PG STRING_AGG skip NULL. Mongo runtime devra filter les
 * nulls avant reduce — géré dans mongodb.ts post-processing.
 */
export const mongoStringAgg: EngineRenderer = (args, ctx) => {
	const arg = ctx.renderExpr(args[0]);
	return ctx.unique === true ? { $addToSet: arg } : { $push: arg };
};

/**
 * `json_agg(x)` — miroir array_agg (Mongo n'a pas de type JSON distinct,
 * les arrays BSON sont natifs). Sémantique préserve NULL comme PG.
 */
export const mongoJsonAgg: EngineRenderer = (args, ctx) => {
	const arg = ctx.renderExpr(args[0]);
	return ctx.unique === true ? { $addToSet: arg } : { $push: arg };
};

// ─── sprint T2/9 : window functions ─────────────────────────────────────────

/**
 * Mongo `$setWindowFields` — chaque window fn produit un accumulator body
 * qui est set sur un slot du doc. Le codegen mongodb.ts wrap avec
 * `$setWindowFields: {partitionBy, sortBy, output: {slot: <body>}}`. Ces
 * renderers retournent juste le body accumulator (pas le wrapper stage).
 *
 * `row_number()` → `{$rank: {}}` — non, Mongo utilise `$documentNumber`.
 * `rank()` → `{$rank: {}}`.
 * `dense_rank()` → `{$denseRank: {}}`.
 */
export const mongoRowNumber: EngineRenderer = () => ({ $documentNumber: {} });
export const mongoRank: EngineRenderer = () => ({ $rank: {} });
export const mongoDenseRank: EngineRenderer = () => ({ $denseRank: {} });
