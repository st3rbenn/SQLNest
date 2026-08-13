/**
 * Renderers Postgres pour les builtins SNQL (sprint 1 : 8 fonctions, sprint 3
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

// ─── sprint 3 : string ─────────────────────────────────────────────────────

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

// ─── sprint 3 : number ─────────────────────────────────────────────────────

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

// ─── sprint 3 : date ───────────────────────────────────────────────────────

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
 * dates. Whitelist réduite sprint 3 : {day, hour, minute, second}. FLOOR
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
