/**
 * Renderers T-SQL (MSSQL) pour les builtins SNQL — chantier M/3. Cible dev =
 * SQL Server 2022 ; les usages 2016+/2022+ (DATETRUNC, GREATEST/LEAST,
 * JSON_VALUE path bindé, TRIM(x FROM y), LTRIM 2-args) sont notés pour la
 * passe 2014 (M/7 : audit + compensations).
 *
 * Parité PG = référence : chaque renderer documente la divergence T-SQL
 * absorbée (LEN trailing spaces, AVG int tronqué, CHARINDEX args inversés,
 * DATEDIFF boundary-count vs durée…).
 */

import { extractStringLiteralArg } from "./builtins-shared";
import type { DateAddUnit, DatePartUnit, DateTruncUnit } from "./date-units";
import type { EngineRenderer } from "./registry";

function renderArgs(
	args: readonly unknown[],
	ctx: { renderExpr: (e: unknown) => unknown }
): string[] {
	return args.map((a) => ctx.renderExpr(a) as string);
}

/** `upper(t)` → `UPPER(<t>)` */
export const mssqlUpper: EngineRenderer = (args, ctx) => {
	const [a] = renderArgs(args, ctx);
	return `UPPER(${a})`;
};

/** `lower(t)` → `LOWER(<t>)` */
export const mssqlLower: EngineRenderer = (args, ctx) => {
	const [a] = renderArgs(args, ctx);
	return `LOWER(${a})`;
};

/**
 * `length(t)` → `(LEN(<t> + N'.') - 1)`. LEN T-SQL IGNORE les espaces de fin
 * (`LEN('a ') = 1`) alors que PG LENGTH les compte — le suffixe `N'.'`
 * neutralise le trim implicite, le `- 1` retire le point. NULL propagate
 * naturellement (NULL + N'.' = NULL).
 */
export const mssqlLength: EngineRenderer = (args, ctx) => {
	const [a] = renderArgs(args, ctx);
	return `(LEN(${a} + N'.') - 1)`;
};

/** `abs(n)` → `ABS(<n>)` */
export const mssqlAbs: EngineRenderer = (args, ctx) => {
	const [a] = renderArgs(args, ctx);
	return `ABS(${a})`;
};

/**
 * `round(n)` / `round(n, digits)`. ROUND T-SQL exige TOUJOURS 2 args — la
 * forme 1-arg émet `ROUND(<n>, 0)`. La forme 2-args cast l'opérande en float
 * (retour float, miroir du contrat PG `::double precision` — préserve
 * `typeof number` côté consumers JS).
 */
export const mssqlRound: EngineRenderer = (args, ctx) => {
	const rendered = renderArgs(args, ctx);
	return rendered.length === 1
		? `ROUND(${rendered[0]}, 0)`
		: `ROUND(CAST(${rendered[0]} AS float), ${rendered[1]})`;
};

/** `coalesce(a, b, …)` → `COALESCE(…)` — variadic min 2, standard. */
export const mssqlCoalesce: EngineRenderer = (args, ctx) => {
	const rendered = renderArgs(args, ctx);
	return `COALESCE(${rendered.join(", ")})`;
};

/** `now()` → `SYSUTCDATETIME()` — instant UTC (datetime2), parité PG NOW()
 *  timestamptz / Mongo `$$NOW` (le driver tedious est en useUTC). */
export const mssqlNow: EngineRenderer = () => "SYSUTCDATETIME()";

/**
 * `concat(a, b, …)` → `CONCAT(…)` — CONCAT T-SQL convertit chaque arg en
 * string nativement et absorbe NULL comme '' (même sémantique que PG CONCAT).
 * CONCAT exige min 2 args côté T-SQL — la forme 1-arg paddée avec `N''`.
 */
export const mssqlConcat: EngineRenderer = (args, ctx) => {
	const rendered = renderArgs(args, ctx);
	if (rendered.length === 1) return `CONCAT(${rendered[0]}, N'')`;
	return `CONCAT(${rendered.join(", ")})`;
};

// ─── string ─────────────────────────────────────────────────────

/** `trim(s)` → `LTRIM(RTRIM(<s>))` (universel) ; `trim(s, chars)` →
 *  `TRIM(<chars> FROM <s>)` (2017+, expression chars 2022 — noté M/7). */
export const mssqlTrim: EngineRenderer = (args, ctx) => {
	const rendered = renderArgs(args, ctx);
	return rendered.length === 1
		? `LTRIM(RTRIM(${rendered[0]}))`
		: `TRIM(${rendered[1]} FROM ${rendered[0]})`;
};

/** `ltrim(s [, chars])` → `LTRIM(<s>[, <chars>])` — forme 2-args = 2022+
 *  (compat level 160), noté M/7. */
export const mssqlLtrim: EngineRenderer = (args, ctx) => {
	const rendered = renderArgs(args, ctx);
	return rendered.length === 1
		? `LTRIM(${rendered[0]})`
		: `LTRIM(${rendered[0]}, ${rendered[1]})`;
};

/** `rtrim(s [, chars])` → `RTRIM(<s>[, <chars>])` — 2-args = 2022+, noté M/7. */
export const mssqlRtrim: EngineRenderer = (args, ctx) => {
	const rendered = renderArgs(args, ctx);
	return rendered.length === 1
		? `RTRIM(${rendered[0]})`
		: `RTRIM(${rendered[0]}, ${rendered[1]})`;
};

/** `substring(s, start, len)` → `SUBSTRING(<s>, CAST(<start> AS int),
 *  CAST(<len> AS int))` — natif 3-args, 1-indexed comme PG. Les CAST
 *  désambigüent les params bindés (miroir du `::int` PG). */
export const mssqlSubstring: EngineRenderer = (args, ctx) => {
	const [s, start, len] = renderArgs(args, ctx);
	return `SUBSTRING(${s}, CAST(${start} AS int), CAST(${len} AS int))`;
};

/** `replace(s, from, to)` → `REPLACE(…)` — littéral pur, jamais regex. */
export const mssqlReplace: EngineRenderer = (args, ctx) => {
	const [s, from, to] = renderArgs(args, ctx);
	return `REPLACE(${s}, ${from}, ${to})`;
};

/** `strpos(haystack, needle)` → `CHARINDEX(<needle>, <haystack>)` — ATTENTION
 *  l'ordre des args T-SQL est INVERSÉ (needle d'abord). 1-indexed, 0 si
 *  absent — même contrat que STRPOS PG. */
export const mssqlStrpos: EngineRenderer = (args, ctx) => {
	const [h, n] = renderArgs(args, ctx);
	return `CHARINDEX(${n}, ${h})`;
};

// ─── number ─────────────────────────────────────────────────────

/** `floor(n)` → `FLOOR(<n>)`. */
export const mssqlFloor: EngineRenderer = (args, ctx) => {
	const [n] = renderArgs(args, ctx);
	return `FLOOR(${n})`;
};

/** `ceil(n)` → `CEILING(<n>)` — T-SQL n'a pas l'alias CEIL. */
export const mssqlCeil: EngineRenderer = (args, ctx) => {
	const [n] = renderArgs(args, ctx);
	return `CEILING(${n})`;
};

// ─── date ───────────────────────────────────────────────────────

/** `today()` → `CAST(SYSUTCDATETIME() AS date)` — UTC forcé, parité
 *  pgToday/Mongo `$$NOW`. */
export const mssqlToday: EngineRenderer = () =>
	"CAST(SYSUTCDATETIME() AS date)";

/** Unit SNQL → datepart T-SQL (DATEPART/DATEADD partagent le vocabulaire). */
const MSSQL_DATEPART: Readonly<Record<string, string>> = {
	year: "year",
	quarter: "quarter",
	month: "month",
	week: "week",
	day: "day",
	hour: "hour",
	minute: "minute",
	second: "second",
	doy: "dayofyear"
};

/**
 * `date_part(unit, d)` → `DATEPART(<unit>, <d>)`.
 *  - `epoch` → `DATEDIFF_BIG(second, '1970-01-01', <d>)` (2016+, noté M/7 —
 *    DATEDIFF int déborde en 2038).
 *  - `dow` → formule indépendante de `@@DATEFIRST` pour la convention PG
 *    (dimanche=0..samedi=6) : `(DATEPART(weekday, d) + @@DATEFIRST - 1) % 7`.
 * Les valeurs datetime sont stockées/lues en UTC (useUTC driver) — pas de
 * conversion AT TIME ZONE nécessaire, contrairement au timestamptz PG.
 */
export const mssqlDatePart: EngineRenderer = (args, ctx) => {
	const unit = extractStringLiteralArg(args[0], "date_part", 0) as DatePartUnit;
	const d = ctx.renderExpr(args[1]) as string;
	if (unit === "epoch") {
		return `DATEDIFF_BIG(second, '1970-01-01', ${d})`;
	}
	if (unit === "dow") {
		return `((DATEPART(weekday, ${d}) + @@DATEFIRST - 1) % 7)`;
	}
	return `DATEPART(${MSSQL_DATEPART[unit]}, ${d})`;
};

/**
 * `date_trunc(unit, d)` → `DATETRUNC(<unit>, <d>)` (2022+ — noté M/7 :
 * compensation DATEADD/DATEDIFF sur 2014). `week` → `iso_week` : PG
 * date_trunc('week') tronque au lundi ISO indépendamment de la session,
 * DATETRUNC(week) dépendrait de @@DATEFIRST.
 */
export const mssqlDateTrunc: EngineRenderer = (args, ctx) => {
	const unit = extractStringLiteralArg(args[0], "date_trunc", 0) as DateTruncUnit;
	const d = ctx.renderExpr(args[1]) as string;
	const datepart = unit === "week" ? "iso_week" : MSSQL_DATEPART[unit];
	return `DATETRUNC(${datepart}, ${d})`;
};

/** `date_add(unit, d, amount)` → `DATEADD(<unit>, <amount>, <d>)` — tous les
 *  units SNQL sont natifs T-SQL (quarter inclus, pas de hack months*3). */
export const mssqlDateAdd: EngineRenderer = (args, ctx) => {
	const unit = extractStringLiteralArg(args[0], "date_add", 0) as DateAddUnit;
	const d = ctx.renderExpr(args[1]) as string;
	const amount = ctx.renderExpr(args[2]) as string;
	return `DATEADD(${MSSQL_DATEPART[unit]}, CAST(${amount} AS int), ${d})`;
};

/**
 * `date_diff(unit, later, earlier)` — parité PG stricte, PAS le DATEDIFF nu :
 * DATEDIFF T-SQL compte les FRONTIÈRES franchies (hour entre 10:59 et 11:01
 * = 1) alors que PG mesure la durée réelle (= 0).
 *  - `day` : différence calendaire → `DATEDIFF(day, CAST(e AS date),
 *    CAST(l AS date))` (boundary-count sur dates pures = calendaire exact,
 *    aligné PG `later::date - earlier::date`).
 *  - `hour`/`minute`/`second` : durée réelle →
 *    `FLOOR(DATEDIFF_BIG(millisecond, e, l) / N)` casté int (miroir
 *    FLOOR(EPOCH/N)::int PG, sub-seconde fidèle).
 */
export const mssqlDateDiff: EngineRenderer = (args, ctx) => {
	const unit = extractStringLiteralArg(args[0], "date_diff", 0);
	const later = ctx.renderExpr(args[1]) as string;
	const earlier = ctx.renderExpr(args[2]) as string;
	if (unit === "day") {
		return `DATEDIFF(day, CAST(${earlier} AS date), CAST(${later} AS date))`;
	}
	const msDiff = `DATEDIFF_BIG(millisecond, ${earlier}, ${later})`;
	switch (unit) {
		case "second":
			return `CAST(FLOOR(${msDiff} / 1000.0) AS int)`;
		case "minute":
			return `CAST(FLOOR(${msDiff} / 60000.0) AS int)`;
		case "hour":
			return `CAST(FLOOR(${msDiff} / 3600000.0) AS int)`;
		default:
			// argEnum au lower a déjà filtré — defense-in-depth.
			return `CAST(FLOOR(${msDiff} / 1000.0) AS int)`;
	}
};

// ─── JSON ───────────────────────────────────────────────────────

/** Duck-type d'un segment path JSON literal (miroir pg segmentValue). */
function segmentValue(arg: unknown): string | number {
	const literal = arg as { kind?: unknown; value?: unknown };
	if (literal.kind !== "literal") {
		throw new Error(
			"mssql json path segment : literal attendu (bug lower — guard aurait dû bloquer)"
		);
	}
	const v = literal.value as string | number;
	if (typeof v === "string" || typeof v === "number") return v;
	throw new Error(
		`mssql json path segment : type ${typeof v} inattendu (bug lower)`
	);
}

/**
 * Path JSON T-SQL depuis les segments literals : `$."a"[0]."b"`. Les segments
 * string sont escapés (`"` → `\"`) — le path complet est ensuite BINDÉ en un
 * seul paramètre (JSON_VALUE/JSON_QUERY acceptent un path variable 2017+),
 * jamais inliné.
 */
function mssqlJsonPath(args: readonly unknown[]): string {
	let path = "$";
	for (let i = 1; i < args.length; i += 1) {
		const seg = segmentValue(args[i]);
		path += typeof seg === "number"
			? `[${seg}]`
			: `."${seg.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
	}
	return path;
}

/**
 * `json_get(doc, ...path)` → `COALESCE(JSON_QUERY(d, @p), JSON_VALUE(d, @p))`.
 * T-SQL sépare object/array (JSON_QUERY) et scalaires (JSON_VALUE) — le
 * COALESCE réunit les deux pour la sémantique `->` PG (le hop renvoie
 * n'importe quel type JSON). Les scalaires sortent en texte nu (nvarchar,
 * pas de type json T-SQL) — utilisable en compare/pick comme côté PG.
 */
export const mssqlJsonGet: EngineRenderer = (args, ctx) => {
	if (ctx.addParam === undefined) {
		throw new Error("mssql json_get : ctx.addParam requis (path bindé)");
	}
	const doc = ctx.renderExpr(args[0]) as string;
	const path = mssqlJsonPath(args);
	return `COALESCE(JSON_QUERY(${doc}, ${ctx.addParam(path)}), JSON_VALUE(${doc}, ${ctx.addParam(path)}))`;
};

/**
 * `json_get_text(doc, ...path)` → priorité au scalaire texte nu
 * (`JSON_VALUE` = `->>` PG), fallback JSON_QUERY pour un dernier hop
 * object/array (PG `->>` sérialise le JSON en text).
 */
export const mssqlJsonGetText: EngineRenderer = (args, ctx) => {
	if (ctx.addParam === undefined) {
		throw new Error("mssql json_get_text : ctx.addParam requis (path bindé)");
	}
	const doc = ctx.renderExpr(args[0]) as string;
	const path = mssqlJsonPath(args);
	return `COALESCE(JSON_VALUE(${doc}, ${ctx.addParam(path)}), JSON_QUERY(${doc}, ${ctx.addParam(path)}))`;
};

// ─── conditional ─────────────────────────────────────────────

/** `if(cond, then, else)` → `IIF(<c>, <t>, <e>)` — natif T-SQL 2012+. */
export const mssqlIf: EngineRenderer = (args, ctx) => {
	const [c, t, e] = renderArgs(args, ctx);
	return `IIF(${c}, ${t}, ${e})`;
};

/** `nullif(a, b)` → `NULLIF(…)` — standard. */
export const mssqlNullif: EngineRenderer = (args, ctx) => {
	const [a, b] = renderArgs(args, ctx);
	return `NULLIF(${a}, ${b})`;
};

/** `greatest(…)` → `GREATEST(…)` — 2022+ (noté M/7 : compensation CASE). */
export const mssqlGreatest: EngineRenderer = (args, ctx) => {
	const rendered = renderArgs(args, ctx);
	return `GREATEST(${rendered.join(", ")})`;
};

/** `least(…)` → `LEAST(…)` — 2022+ (noté M/7). */
export const mssqlLeast: EngineRenderer = (args, ctx) => {
	const rendered = renderArgs(args, ctx);
	return `LEAST(${rendered.join(", ")})`;
};

// ─── aggregates scalaires ────────────────────────────────────

/**
 * `count` → `COUNT_BIG` (bigint, parité type PG COUNT). `count(*)` star,
 * `count(unique x)` DISTINCT, `count(x)` NULL-ignore natif.
 */
export const mssqlCount: EngineRenderer = (args, ctx) => {
	if (ctx.star === true) return "COUNT_BIG(*)";
	const [a] = renderArgs(args, ctx);
	if (ctx.unique === true) return `COUNT_BIG(DISTINCT ${a})`;
	return `COUNT_BIG(${a})`;
};

/** `sum(x)` → `CAST(SUM(<x>) AS float)` — contrat `typeof number` homogène
 *  (miroir `::double precision` PG). Empty → NULL natif. */
export const mssqlSum: EngineRenderer = (args, ctx) => {
	const [a] = renderArgs(args, ctx);
	return `CAST(SUM(${a}) AS float)`;
};

/**
 * `avg(x)` → `AVG(CAST(<x> AS float))` — AVG T-SQL sur int renvoie un int
 * TRONQUÉ (avg(1,2) = 1) : le cast en amont force l'arithmétique flottante,
 * parité PG AVG numeric.
 */
export const mssqlAvg: EngineRenderer = (args, ctx) => {
	const [a] = renderArgs(args, ctx);
	return `AVG(CAST(${a} AS float))`;
};

/** `min(x)` → `MIN(<x>)` — passthrough type, NULL-ignore natif. */
export const mssqlMin: EngineRenderer = (args, ctx) => {
	const [a] = renderArgs(args, ctx);
	return `MIN(${a})`;
};

/** `max(x)` → `MAX(<x>)` — miroir min. */
export const mssqlMax: EngineRenderer = (args, ctx) => {
	const [a] = renderArgs(args, ctx);
	return `MAX(${a})`;
};

// ─── aggregateMulti ─────────────────────────────────────────

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
function bracketIdent(name: string): string {
	if (!IDENT_RE.test(name)) {
		throw new Error(`Identifiant invalide '${name}'`);
	}
	return `[${name}]`;
}

/**
 * `string_agg(x, sep [sort k])` → `STRING_AGG(CONVERT(nvarchar(max), <x>),
 * <sep>) [WITHIN GROUP (ORDER BY …)]` (2017+ — noté M/7 : FOR XML PATH sur
 * 2014). CONVERT force nvarchar(max) : sans lui STRING_AGG tronque à 8000
 * octets ET refuse les types non-string. NULL-skip natif, parité PG.
 * `unique` refusé : STRING_AGG T-SQL n'a pas de DISTINCT (contrairement à
 * PG) — erreur codegen typée plutôt qu'un dedup silencieusement absent.
 */
export const mssqlStringAgg: EngineRenderer = (args, ctx) => {
	if (ctx.unique === true) {
		throw new Error(
			"string_agg(unique …) non supporté sur MSSQL (STRING_AGG n'a pas de DISTINCT)"
		);
	}
	const [a, sep] = renderArgs(args, ctx);
	let sql = `STRING_AGG(CONVERT(nvarchar(max), ${a}), ${sep})`;
	if (ctx.sortKeys !== undefined && ctx.sortKeys.length > 0) {
		const order = ctx.sortKeys
			.map((k) => {
				const path = k.path.map(bracketIdent).join(".");
				return `${path} ${k.direction === "desc" ? "DESC" : "ASC"}`;
			})
			.join(", ");
		sql += ` WITHIN GROUP (ORDER BY ${order})`;
	}
	return sql;
};

// ─── window functions ─────────────────────────────────────────

/** `row_number()` → `ROW_NUMBER()` — OVER émis par le codegen. */
export const mssqlRowNumber: EngineRenderer = () => `ROW_NUMBER()`;

/** `rank()` → `RANK()`. */
export const mssqlRank: EngineRenderer = () => `RANK()`;

/** `dense_rank()` → `DENSE_RANK()`. */
export const mssqlDenseRank: EngineRenderer = () => `DENSE_RANK()`;
