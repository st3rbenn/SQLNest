/**
 * Le Token Dictionary : vocabulaire de surface de SNQL.
 * Associe les mots de surface (avec synonymes) à des concepts canoniques.
 * Voir le vault : `03 - SNQL/Token Dictionary`.
 */

export type OperationKind = "select" | "insert" | "update" | "delete";

/** Verbes d'intention → opération canonique. Un canonique + un alias par opération. */
export const VERB_SYNONYMS: Readonly<Record<string, OperationKind>> = {
	get: "select",
	find: "select",
	add: "insert",
	create: "insert",
	update: "update",
	edit: "update",
	remove: "delete",
	delete: "delete"
};

/**
 * Mots-clés de structure reconnus par le lexer (hors littéraux true/false/null,
 * traités à part). Certains ne sont pas encore consommés par le parser (Slice 1)
 * mais sont réservés pour éviter qu'ils soient pris pour des identifiants.
 */
export const KEYWORDS: ReadonlySet<string> = new Set([
	"where",
	"pick",
	"sort",
	"limit",
	"take",
	"offset",
	"into",
	"set",
	"from",
	"as",
	"with",
	"on",
	"one",
	"many",
	"group",
	"by",
	"having",
	"over",
	"partition",
	"exists",
	"conflict",
	"ignore",
	"transaction",
	"savepoint",
	"isolation",
	"committed",
	"repeatable",
	"serializable",
	"and",
	"or",
	"not",
	"in",
	"like",
	"asc",
	"desc"
]);

/** Alias de mots-clés normalisés à la lecture (ex. `take` → `limit`). */
export const KEYWORD_ALIASES: Readonly<Record<string, string>> = {
	take: "limit"
};

/**
 * Verbes d'introspection T3 — soft-keywords contextuels (détectés au parser
 * en tête de statement uniquement, pour ne pas rentrer en conflit avec un
 * usage `pick x as list`/`as describe`). Absent de [[KEYWORDS]] à dessein —
 * mais highlightés comme des keywords côté éditeur.
 */
export const INTROSPECT_VERBS: ReadonlySet<string> = new Set([
	"list",
	"describe",
	// T3/2.4 : `for` — filter shortcut. Highlight comme keyword, mais reste
	// soft-keyword (utilisable en ident hors introspect).
	"for",
	// T3/4 : `raw` escape hatch — highlight bleu. Soft-keyword aussi.
	"raw",
	// T3/6 : `let` — CTE binding. Highlight bleu, soft-keyword.
	"let"
]);

/**
 * Retourne l'opération canonique d'un verbe, ou `undefined` si le mot n'est pas un verbe.
 * `Object.hasOwn` évite que des propriétés héritées (`constructor`, `__proto__`) remontent
 * comme des verbes et cassent la tokenisation d'identifiants ainsi nommés.
 */
export function verbOperation(word: string): OperationKind | undefined {
	return Object.hasOwn(VERB_SYNONYMS, word) ? VERB_SYNONYMS[word] : undefined;
}
