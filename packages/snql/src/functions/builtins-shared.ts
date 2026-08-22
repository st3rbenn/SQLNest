/**
 * Helpers partagés entre les renderers PG/Mongo. Utilisés par les fonctions
 * unit-driven (date_part / date_trunc / date_add / date_diff) qui font un
 * switch statique sur un arg littéral string.
 */

import { SnqlError } from "../diagnostics";

/**
 * Duck-type un arg PlanExpr et extrait sa valeur si c'est un `{ kind: "literal",
 * value: <string> }`. Renvoie la string canonique lowercase.
 *
 * Le lower a déjà validé via `argEnum` — arriver ici avec un non-literal ou
 * une valeur hors whitelist = bug de synchronisation registre ↔ lower. Le
 * throw est defense-in-depth (`codegen_missing_function_mapping`).
 */
export function extractStringLiteralArg(
	arg: unknown,
	fnName: string,
	argIndex: number
): string {
	if (
		typeof arg === "object" &&
		arg !== null &&
		(arg as { kind?: unknown }).kind === "literal"
	) {
		const value = (arg as { value?: unknown }).value;
		if (typeof value === "string") {
			return value.toLowerCase();
		}
	}
	throw new SnqlError(
		`Fonction '${fnName}' arg ${argIndex + 1} : littéral string requis (bug lower — argEnum aurait dû bloquer)`,
		"codegen_missing_function_mapping"
	);
}

// ─── helpers JSON path ──────────────────────────────────────────

/**
 * Un segment path JSON canonique : string (clé objet) ou int positif ≤ INT32_MAX
 * (index array). Le lower a déjà validé le type — le renderer discrimine sur la
 * représentation littérale pour choisir `->` vs `->>` et `::text` vs `::int`.
 */
export type JsonPathSegment =
	| { readonly kind: "key"; readonly value: string }
	| { readonly kind: "index"; readonly value: number };

/**
 * Duck-type un PlanExpr `{ kind: "field", path }` et retourne son path relatif
 * à `alias` (drop l'alias source de tête). Renvoie `null` si l'arg n'est pas
 * un field pur — utilisé par `extractStaticDotPath` pour rejeter les calls
 * imbriqués (`json_get(json_get(x, 'a'), 'b')` — hoist échoue).
 */
function fieldPathOf(
	arg: unknown,
	alias: string | undefined
): readonly string[] | null {
	if (
		typeof arg !== "object" ||
		arg === null ||
		(arg as { kind?: unknown }).kind !== "field"
	) {
		return null;
	}
	const path = (arg as { path?: readonly string[] }).path;
	if (!Array.isArray(path) || path.length === 0) return null;
	// Drop l'alias source de tête si présent : `get t as x pick json_get(x.meta, 'k')`
	// → hoist doit émettre `{'meta.k': ...}`, pas `{'x.meta.k': ...}`.
	if (alias !== undefined && path.length > 1 && path[0] === alias) {
		return path.slice(1);
	}
	return path;
}

/**
 * Duck-type un PlanExpr literal et retourne sa valeur brute si c'est un
 * segment valide (string non-vide OU number entier positif ≤ INT32_MAX).
 * Renvoie `null` sinon — le hoist doit alors échouer.
 */
function segmentLiteralOf(arg: unknown): string | number | null {
	if (typeof arg !== "object" || arg === null) return null;
	if ((arg as { kind?: unknown }).kind !== "literal") return null;
	const value = (arg as { value?: unknown }).value;
	if (
		typeof value === "object" &&
		value !== null &&
		(value as { kind?: unknown }).kind === "literal"
	) {
		// PlanExpr literal wraps une LiteralValue à un niveau plus bas
		const inner = (value as { value?: unknown }).value;
		if (typeof inner === "string" && inner.length > 0) return inner;
		if (
			typeof inner === "number" &&
			Number.isInteger(inner) &&
			inner >= 0 &&
			inner <= 2147483647
		) {
			return inner;
		}
		return null;
	}
	// PlanExpr literal direct : { kind: 'literal', value: string|number }
	if (typeof value === "string" && value.length > 0) return value;
	if (
		typeof value === "number" &&
		Number.isInteger(value) &&
		value >= 0 &&
		value <= 2147483647
	) {
		return value;
	}
	return null;
}

/**
 * Extrait le dot-path Mongo natif si `args[0]` est un field pur ET tous les
 * segments suivants sont des literals string/int valides. Utilisé par le
 * codegen Mongo pour hoister `where json_get(doc, 'a', 0, 'b') = 'v'` en
 * `{'doc.a.0.b': 'v'}` indexable natif.
 *
 * Renvoie `null` si le hoist échoue (arg[0] pas field, un segment dynamique,
 * un segment invalide). Le codegen bascule alors sur `$expr` fallback.
 */
export function extractStaticDotPath(
	args: readonly unknown[],
	alias: string | undefined
): string | null {
	const rootPath = fieldPathOf(args[0], alias);
	if (rootPath === null) return null;
	const segments: (string | number)[] = [];
	for (let i = 1; i < args.length; i += 1) {
		const seg = segmentLiteralOf(args[i]);
		if (seg === null) return null;
		segments.push(seg);
	}
	return [...rootPath, ...segments.map(String)].join(".");
}
