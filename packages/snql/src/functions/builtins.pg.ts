/**
 * Renderers Postgres pour les builtins SNQL (8 fonctions,
 * : +11 fonctions). Chaque renderer reçoit les args déjà rendus en SQL
 * (strings) via `ctx.renderExpr` — c'est du string assembly typé côté engine.
 */

import { extractStringLiteralArg } from "./builtins-shared";
import { PG_MAKE_INTERVAL_MAP, type DateAddUnit } from "./date-units";
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
 *
 * Quirk PG à absorber : `round(double precision, int)` **n'existe pas** —
 * seul `round(numeric, int)` est défini. Sans intervention, un
 * `round(cast(x as float), 3)` throw `42883 function round(double precision,
 * unknown) does not exist`. Le renderer applique donc pour la forme 2-args :
 *  1. cast intermédiaire `::numeric` sur l'opérande → PG accepte round
 *  2. re-cast final `::double precision` → préserve le contrat de type d'API
 *     (le driver pg sérialise `numeric` en **string**, cassant
 *     `typeof r === "number"` côté consumers JS). Double-cast = zéro friction.
 *
 * La forme 1-arg reste inchangée : `ROUND(x)` accepte double ET numeric.
 */
export const pgRound: EngineRenderer = (args, ctx) => {
	const rendered = renderArgs(args, ctx);
	return rendered.length === 1
		? `ROUND(${rendered[0]})`
		: `ROUND((${rendered[0]})::numeric, ${rendered[1]})::double precision`;
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

// ─── string ─────────────────────────────────────────────────────

/** `trim(s [, chars])` → `BTRIM(<s>)` / `BTRIM(<s>, <chars>)` — jamais syntaxe TRIM(BOTH … FROM …). */
export const pgTrim: EngineRenderer = (args, ctx) => {
	const rendered = renderArgs(args, ctx);
	return rendered.length === 1
		? `BTRIM(${rendered[0]})`
		: `BTRIM(${rendered[0]}, ${rendered[1]})`;
};

/** `ltrim(s [, chars])` → `LTRIM(<s>)` / `LTRIM(<s>, <chars>)`. */
export const pgLtrim: EngineRenderer = (args, ctx) => {
	const rendered = renderArgs(args, ctx);
	return rendered.length === 1
		? `LTRIM(${rendered[0]})`
		: `LTRIM(${rendered[0]}, ${rendered[1]})`;
};

/** `rtrim(s [, chars])` → `RTRIM(<s>)` / `RTRIM(<s>, <chars>)`. */
export const pgRtrim: EngineRenderer = (args, ctx) => {
	const rendered = renderArgs(args, ctx);
	return rendered.length === 1
		? `RTRIM(${rendered[0]})`
		: `RTRIM(${rendered[0]}, ${rendered[1]})`;
};

/**
 * `substring(s, start, len)` → `SUBSTRING(<s>, (<start>)::int, (<len>)::int)`
 * — forme fonction (jamais `SUBSTRING(s FROM start FOR len)`). 1-indexed.
 *
 * Cast `::int` obligatoire sur start/len : PG a **deux overloads** —
 * `substring(text, int, int)` et `substring(text, text, text)` (regex SQL).
 * Avec des params bindés unknown, PG résout vers la variante regex et
 * retourne NULL sans erreur (silencieux !). Le cast désambigüe côté SQL,
 * exact même pattern que `pgConcat ::text` pour `42P18 indeterminate datatype`.
 *
 * Le lower a déjà bloqué `substring(s, 0, N)` littéral via
 * `lower_call_substring_zero_index`.
 */
export const pgSubstring: EngineRenderer = (args, ctx) => {
	const [s, start, len] = renderArgs(args, ctx);
	return `SUBSTRING(${s}, (${start})::int, (${len})::int)`;
};

/** `replace(s, from, to)` → `REPLACE(<s>, <from>, <to>)` — littéral pur, jamais regex. */
export const pgReplace: EngineRenderer = (args, ctx) => {
	const [s, from, to] = renderArgs(args, ctx);
	return `REPLACE(${s}, ${from}, ${to})`;
};

/**
 * `strpos(haystack, needle)` → `STRPOS(<h>, <n>)`. Retourne 1-indexed
 * (position), 0 si absent — convention PG/SQL. Jamais `POSITION(n IN h)`
 * (syntaxe spéciale bannie).
 */
export const pgStrpos: EngineRenderer = (args, ctx) => {
	const [h, n] = renderArgs(args, ctx);
	return `STRPOS(${h}, ${n})`;
};

// ─── number ─────────────────────────────────────────────────────

/** `floor(n)` → `FLOOR(<n>)`. */
export const pgFloor: EngineRenderer = (args, ctx) => {
	const [n] = renderArgs(args, ctx);
	return `FLOOR(${n})`;
};

/** `ceil(n)` → `CEIL(<n>)`. */
export const pgCeil: EngineRenderer = (args, ctx) => {
	const [n] = renderArgs(args, ctx);
	return `CEIL(${n})`;
};

// ─── date ───────────────────────────────────────────────────────

/**
 * `today()` → `((NOW() AT TIME ZONE 'UTC')::date)`. UTC forcé pour parité
 * cross-engine (Mongo `$$NOW` est toujours UTC). `CURRENT_DATE` PG utilise
 * la session-TZ, non portable — évité volontairement.
 */
export const pgToday: EngineRenderer = () =>
	"((NOW() AT TIME ZONE 'UTC')::date)";

/**
 * `date_part(unit, d)` → `EXTRACT(<unit> FROM (<d> AT TIME ZONE 'UTC'))::int`
 * (ou `::bigint` pour epoch). `AT TIME ZONE 'UTC'` systématique pour parité
 * Mongo. Cast final `::int` pour parité type avec Mongo int32.
 */
export const pgDatePart: EngineRenderer = (args, ctx) => {
	const unit = extractStringLiteralArg(args[0], "date_part", 0);
	const d = ctx.renderExpr(args[1]) as string;
	if (unit === "epoch") {
		return `EXTRACT(EPOCH FROM (${d} AT TIME ZONE 'UTC'))::bigint`;
	}
	return `EXTRACT(${unit} FROM (${d} AT TIME ZONE 'UTC'))::int`;
};

/**
 * `date_trunc(unit, d)` → `DATE_TRUNC('<unit>', (<d> AT TIME ZONE 'UTC'))`.
 * UTC forcé pour parité Mongo. Unit en littéral SQL (guillemets simples).
 */
export const pgDateTrunc: EngineRenderer = (args, ctx) => {
	const unit = extractStringLiteralArg(args[0], "date_trunc", 0);
	const d = ctx.renderExpr(args[1]) as string;
	return `DATE_TRUNC('${unit}', (${d} AT TIME ZONE 'UTC'))`;
};

/**
 * `date_add(unit, d, amount)` → `(<d> + MAKE_INTERVAL(<key> => <amount>))`.
 * Fix quarter : MAKE_INTERVAL n'a pas `quarters` — mapping vers months*3
 * via `PG_MAKE_INTERVAL_MAP`. amount peut être négatif (soustraction implicite).
 */
export const pgDateAdd: EngineRenderer = (args, ctx) => {
	const unit = extractStringLiteralArg(args[0], "date_add", 0) as DateAddUnit;
	const d = ctx.renderExpr(args[1]) as string;
	const amount = ctx.renderExpr(args[2]) as string;
	const mapping = PG_MAKE_INTERVAL_MAP[unit];
	const amountExpr =
		mapping.multiplier === 1 ? amount : `(${amount} * ${mapping.multiplier})`;
	return `(${d} + MAKE_INTERVAL(${mapping.key} => ${amountExpr}))`;
};

/**
 * `date_diff(unit, later, earlier)` → nombre entier de units entre les deux
 * dates. Whitelist réduite {day, hour, minute, second}. FLOOR
 * obligatoire (`::int` seul ferait banker rounding, casse la parité Mongo
 * truncate). Résultat positif si later > earlier.
 */
export const pgDateDiff: EngineRenderer = (args, ctx) => {
	const unit = extractStringLiteralArg(args[0], "date_diff", 0);
	const later = ctx.renderExpr(args[1]) as string;
	const earlier = ctx.renderExpr(args[2]) as string;
	if (unit === "day") {
		return `(${later}::date - ${earlier}::date)`;
	}
	const epochDiff = `EXTRACT(EPOCH FROM (${later} - ${earlier}))`;
	switch (unit) {
		case "second":
			return `FLOOR(${epochDiff})::int`;
		case "minute":
			return `FLOOR(${epochDiff} / 60)::int`;
		case "hour":
			return `FLOOR(${epochDiff} / 3600)::int`;
		default:
			// argEnum au lower a déjà filtré — defense-in-depth.
			return `FLOOR(${epochDiff})::int`;
	}
};

// ─── JSON ───────────────────────────────────────────────────────

/**
 * Duck-type un PlanExpr literal pour un segment path JSON. Renvoie la
 * valeur brute si c'est un literal string ou number entier positif ≤ INT32_MAX.
 * Le lower a déjà validé — le renderer discrimine sur le type de la value pour
 * choisir le cast `::text` ou `::int`.
 */
function segmentValue(arg: unknown): string | number {
	const literal = arg as { kind?: unknown; value?: unknown };
	if (literal.kind !== "literal") {
		throw new Error(
			"pg json path segment : literal attendu (bug lower — guard aurait dû bloquer)"
		);
	}
	const v = literal.value as string | number;
	if (typeof v === "string" || typeof v === "number") return v;
	throw new Error(
		`pg json path segment : type ${typeof v} inattendu (bug lower)`
	);
}

/**
 * Helper factorisé pour json_get et json_get_text. Rend la chain d'opérateurs
 * `->` PG (`->>` sur le dernier hop si `lastAsText`). Chaque segment passe par
 * `ctx.addParam` (JAMAIS d'inline string user-controlled) avec cast `::text`
 * ou `::int` per-segment — désambigüe l'overload PG jsonb∘text vs jsonb∘int
 * sur param bindé (sans cast, `0` bindé tomberait silencieusement sur
 * overload text et chercherait la clé "0").
 */
function pgRenderJsonPathChain(
	args: readonly unknown[],
	ctx: { renderExpr: (e: unknown) => unknown; addParam?: (v: unknown) => string },
	lastAsText: boolean
): string {
	if (ctx.addParam === undefined) {
		throw new Error(
			"pg json_get* : ctx.addParam requis pour la sécurité (params bindés per-segment)"
		);
	}
	const doc = ctx.renderExpr(args[0]) as string;
	let sql = doc;
	const lastIdx = args.length - 1;
	for (let i = 1; i < args.length; i += 1) {
		const value = segmentValue(args[i]);
		const isLast = i === lastIdx;
		const op = isLast && lastAsText ? "->>" : "->";
		const cast = typeof value === "string" ? "::text" : "::int";
		sql = `(${sql} ${op} ${ctx.addParam(value)}${cast})`;
	}
	return sql;
}

/**
 * `json_get(doc, ...path)` → chaine `->` PG, retour jsonb. Chaque segment est
 * bindé + cast pour désambigüer l'overload jsonb∘text vs jsonb∘int.
 */
export const pgJsonGet: EngineRenderer = (args, ctx) =>
	pgRenderJsonPathChain(args, ctx, false);

/**
 * `json_get_text(doc, ...path)` → identique à `json_get` mais dernier hop
 * utilise `->>` (déserialise scalaire en text natif, pas `'"a"'` avec guillemets
 * JSON). C'est pourquoi c'est une fonction distincte, PAS un raccourci
 * `cast(json_get as text)`.
 */
export const pgJsonGetText: EngineRenderer = (args, ctx) =>
	pgRenderJsonPathChain(args, ctx, true);

/**
 * `json_has_key(doc, "key")` → `((doc) ? $N::text)` PG. TOP-LEVEL uniquement
 * (parité stricte PG `?`). Pour nested → composition
 * `json_has_key(json_get(doc, 'a'), 'b')`. Cast `::text` obligatoire pour
 * désambigüer overload sur param bindé.
 */
export const pgJsonHasKey: EngineRenderer = (args, ctx) => {
	if (ctx.addParam === undefined) {
		throw new Error("pg json_has_key : ctx.addParam requis");
	}
	const doc = ctx.renderExpr(args[0]) as string;
	const key = segmentValue(args[1]);
	return `(${doc} ? ${ctx.addParam(key)}::text)`;
};

/**
 * `json_typeof(doc)` → `jsonb_typeof(<doc>)`. Retour ∈ {'object','array',
 * 'string','number','boolean','null'}. SQL NULL input → SQL NULL.
 */
export const pgJsonTypeof: EngineRenderer = (args, ctx) => {
	const doc = ctx.renderExpr(args[0]) as string;
	return `jsonb_typeof(${doc})`;
};

/**
 * `json_contains(doc, subdoc)` → `((doc)::jsonb @> (subdoc)::jsonb)`.
 * Débloqué le subdoc peut désormais être un object
 * literal SNQL natif (`{archived: true}`) au lieu du workaround
 * `cast("{...}" as json)` (raw JSON déguisé). Mongo reste `reserved`.
 */
export const pgJsonContains: EngineRenderer = (args, ctx) => {
	const doc = ctx.renderExpr(args[0]) as string;
	const subdoc = ctx.renderExpr(args[1]) as string;
	return `((${doc})::jsonb @> (${subdoc})::jsonb)`;
};

// ─── conditional ─────────────────────────────────────────────

/**
 * `if(cond, then, else)` → `CASE WHEN <cond> THEN <then> ELSE <else> END`.
 * Sucre syntaxique 3-arg pour un `case { cond -> then, else -> else }` d'une
 * seule branche. Le codegen PG traduit vers CASE WHEN (pas de fonction PG
 * dédiée `IF` — c'est un `IIF` MSSQL / `IF` MySQL, absent chez PG).
 */
export const pgIf: EngineRenderer = (args, ctx) => {
	const [c, t, e] = renderArgs(args, ctx);
	return `CASE WHEN ${c} THEN ${t} ELSE ${e} END`;
};

/**
 * `nullif(a, b)` → `NULLIF(<a>, <b>)`. Retourne NULL si a=b, sinon a. Pattern
 * classique pour "vider" une valeur sentinelle (nullif(x, '') → NULL si vide).
 */
export const pgNullif: EngineRenderer = (args, ctx) => {
	const [a, b] = renderArgs(args, ctx);
	return `NULLIF(${a}, ${b})`;
};

/**
 * `greatest(a, b, …)` / `least(a, b, …)` → `GREATEST(…)` / `LEAST(…)`. Variadic
 * min 2. NULL-absorb côté PG (contrairement à `max`/`min` aggregate qui les
 * ignorent) — parité maintenue avec Mongo via l'émulation $reduce à l'écrit.
 */
export const pgGreatest: EngineRenderer = (args, ctx) => {
	const rendered = renderArgs(args, ctx);
	return `GREATEST(${rendered.join(", ")})`;
};

export const pgLeast: EngineRenderer = (args, ctx) => {
	const rendered = renderArgs(args, ctx);
	return `LEAST(${rendered.join(", ")})`;
};

// ─── aggregates scalaires ────────────────────────────────────

/**
 * `count(*)` → `COUNT(*)` (ctx.star=true).
 * `count(unique x)` → `COUNT(DISTINCT <x>)` (ctx.unique=true).
 * `count(x)` → `COUNT(<x>)` (NULL-ignore natif PG parité SNQL).
 *
 * Type retour = bigint natif PG. pg driver sérialise > 2^53 en string ;
 * divergence documentée dans knownDivergences (choix v6 : accepter, KV
 * retourne Number via rows.length pour parité < 2^53).
 */
export const pgCount: EngineRenderer = (args, ctx) => {
	if (ctx.star === true) return "COUNT(*)";
	const [a] = renderArgs(args, ctx);
	if (ctx.unique === true) return `COUNT(DISTINCT ${a})`;
	return `COUNT(${a})`;
};

/**
 * `sum(x)` → `SUM(<x>)::double precision` — cast dans le renderer (précédent
 * pgRound double-cast). Rationale : pg driver sérialise numeric/bigint > 2^53
 * en string, cassant `typeof number` consumer JS. Cast `::double precision`
 * préserve le contrat. Perte precision > 2^53 documentée (escape via
 * `cast(sum(x) as decimal)`).
 *
 * Empty → NULL (natif PG SUM sur set vide). NULL args ignorés naturellement.
 */
export const pgSum: EngineRenderer = (args, ctx) => {
	const [a] = renderArgs(args, ctx);
	return `SUM(${a})::double precision`;
};

/**
 * `avg(x)` → `AVG(<x>)::double precision` — même règle homogène que sum.
 * PG AVG(int)/AVG(bigint) natif = numeric ; cast `::double precision` pour
 * préserver typeof number consumer JS.
 */
export const pgAvg: EngineRenderer = (args, ctx) => {
	const [a] = renderArgs(args, ctx);
	return `AVG(${a})::double precision`;
};

/**
 * `min(x)` → `MIN(<x>)` — passthrough type (int→int, timestamp→timestamp).
 * NULL-ignore natif PG. Empty → NULL.
 */
export const pgMin: EngineRenderer = (args, ctx) => {
	const [a] = renderArgs(args, ctx);
	return `MIN(${a})`;
};

/**
 * `max(x)` → `MAX(<x>)` — miroir min.
 */
export const pgMax: EngineRenderer = (args, ctx) => {
	const [a] = renderArgs(args, ctx);
	return `MAX(${a})`;
};

// ─── aggregateMulti ─────────────────────────────────────────

/**
 * Identifiant PG quoté : whitelist stricte `[A-Za-z_][A-Za-z0-9_]*` (miroir de
 * `codegen/postgres.ts:quoteIdent`). Impossible en pratique car parseFieldPath
 * exige déjà un ident valide au lexer — defense-in-depth.
 */
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
function quoteIdent(name: string): string {
	if (!IDENT_RE.test(name)) {
		throw new Error(`Identifiant invalide '${name}'`);
	}
	return `"${name}"`;
}

/**
 * Rend une clause `ORDER BY` PG à partir des sortKeys du call. Vide
 * si `ctx.sortKeys` absent/vide.
 */
function renderOrderByClause(ctx: {
	readonly sortKeys?: readonly {
		readonly path: readonly string[];
		readonly direction: "asc" | "desc";
	}[];
}): string {
	if (ctx.sortKeys === undefined || ctx.sortKeys.length === 0) return "";
	const parts = ctx.sortKeys.map((k) => {
		const path = k.path.map(quoteIdent).join(".");
		return `${path} ${k.direction === "desc" ? "DESC" : "ASC"}`;
	});
	return ` ORDER BY ${parts.join(", ")}`;
}

/**
 * `array_agg(x [sort k])` → `ARRAY_AGG(<x> [ORDER BY k])`. PG conserve NULL
 * dans l'array (contrat SNQL) ; modifier `unique` → `ARRAY_AGG(DISTINCT x)`.
 * Empty group → NULL (parité PG native).
 */
export const pgArrayAgg: EngineRenderer = (args, ctx) => {
	const [a] = renderArgs(args, ctx);
	const distinct = ctx.unique === true ? "DISTINCT " : "";
	return `ARRAY_AGG(${distinct}${a}${renderOrderByClause(ctx)})`;
};

/**
 * `string_agg(x, sep [sort k])` → `STRING_AGG(<x>::text, <sep> [ORDER BY k])`.
 * Cast `::text` sur x pour lever `42883 function string_agg(int, text)` — PG
 * n'a de surcharge que string_agg(text|bytea, ...). NULL-skip natif PG.
 * Empty group → NULL. `unique` → `STRING_AGG(DISTINCT x, sep)`.
 */
export const pgStringAgg: EngineRenderer = (args, ctx) => {
	const [a, sep] = renderArgs(args, ctx);
	const distinct = ctx.unique === true ? "DISTINCT " : "";
	return `STRING_AGG(${distinct}(${a})::text, ${sep}${renderOrderByClause(ctx)})`;
};

/**
 * `json_agg(x [sort k])` → `JSON_AGG(<x> [ORDER BY k])`. Retour json (pas
 * jsonb — préserve l'ordre des éléments). Empty group → NULL (PG natif).
 * `unique` → `JSON_AGG(DISTINCT x)`.
 */
export const pgJsonAgg: EngineRenderer = (args, ctx) => {
	const [a] = renderArgs(args, ctx);
	const distinct = ctx.unique === true ? "DISTINCT " : "";
	return `JSON_AGG(${distinct}${a}${renderOrderByClause(ctx)})`;
};

// ─── window functions ─────────────────────────────────────────

/**
 * `row_number()` → `ROW_NUMBER()`. Le OVER clause est émis par le codegen
 * postgres.ts (renderExpr case windowCall) qui appelle ce renderer pour la
 * partie fonction et append `OVER (PARTITION BY ... ORDER BY ...)` autour.
 * Renderer window : args toujours [] pour row_number/rank/dense_rank.
 */
export const pgRowNumber: EngineRenderer = () => `ROW_NUMBER()`;

/** `rank()` → `RANK()`. */
export const pgRank: EngineRenderer = () => `RANK()`;

/** `dense_rank()` → `DENSE_RANK()`. */
export const pgDenseRank: EngineRenderer = () => `DENSE_RANK()`;
