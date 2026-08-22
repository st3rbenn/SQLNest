/**
 * Whitelists d'units pour les fonctions date_* du. Centralisées ici
 * pour être lues par (a) le lower via `argEnum` (validation + suggestion
 * Levenshtein), (b) les renderers PG/Mongo qui font un switch statique.
 *
 * Chaque fonction a sa propre whitelist : `date_part` (le plus riche, inclut
 * dow/doy/epoch), `date_trunc` (pas de dow/doy/epoch — n'ont pas de sens en
 * troncation), `date_add` (idem trunc), `date_diff` (**réduit ** à
 * day/hour/minute/second car week/month/quarter/year ont une divergence PG
 * AGE calendrier vs Mongo boundary-crossing irréductible sans émulation).
 */

export const DATE_PART_UNITS = [
	"year",
	"quarter",
	"month",
	"week",
	"day",
	"hour",
	"minute",
	"second",
	"dow",
	"doy",
	"epoch"
] as const;

export const DATE_TRUNC_UNITS = [
	"year",
	"quarter",
	"month",
	"week",
	"day",
	"hour",
	"minute",
	"second"
] as const;

export const DATE_ADD_UNITS = [
	"year",
	"quarter",
	"month",
	"week",
	"day",
	"hour",
	"minute",
	"second"
] as const;

// units calendaires (week/month/quarter/year) EXCLUES — PG AGE vs
// Mongo boundary-crossing divergent sur les bords calendaires (ex: entre
// 2026-01-31 et 2026-02-01, PG dit "1 day", Mongo boundary dit "1 month" si
// on demande month). Résolution avec émulation ou 2 canoniques
// distinctes (date_diff_age vs date_diff_boundary).
export const DATE_DIFF_UNITS = [
	"day",
	"hour",
	"minute",
	"second"
] as const;

export type DatePartUnit = (typeof DATE_PART_UNITS)[number];
export type DateTruncUnit = (typeof DATE_TRUNC_UNITS)[number];
export type DateAddUnit = (typeof DATE_ADD_UNITS)[number];
export type DateDiffUnit = (typeof DATE_DIFF_UNITS)[number];

/**
 * Mapping SNQL unit → clé PG MAKE_INTERVAL + multiplicateur. Fix critique :
 * MAKE_INTERVAL n'a **pas** de param `quarters` — quarter est mappé vers
 * `months` avec multiplicateur 3. Les autres sont 1:1.
 *
 * Utilisé par `pgDateAdd` pour émettre `<d> + MAKE_INTERVAL(<key> => <amount>)`
 * avec le multiplicateur intégré au SQL (`amount * 3` pour quarter).
 */
export const PG_MAKE_INTERVAL_MAP: Readonly<
	Record<DateAddUnit, { readonly key: string; readonly multiplier: number }>
> = {
	year: { key: "years", multiplier: 1 },
	quarter: { key: "months", multiplier: 3 },
	month: { key: "months", multiplier: 1 },
	week: { key: "weeks", multiplier: 1 },
	day: { key: "days", multiplier: 1 },
	hour: { key: "hours", multiplier: 1 },
	minute: { key: "mins", multiplier: 1 },
	second: { key: "secs", multiplier: 1 }
};
