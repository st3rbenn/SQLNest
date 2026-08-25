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
 * traités à part). Certains ne sont pas encore consommés par le parser mais
 * sont réservés pour éviter qu'ils soient pris pour des identifiants.
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
	"desc",
	// DDL Tier-2 (ADR-029). `table` fait passer `create table T` en DDL au
	// parser (peek 1 token après `create` — sinon `create` reste alias insert).
	// `primary`/`unique`/`nullable`/`default` sont field-modifiers dans le
	// body `{...}` (D0 exception). `column`/`index`/`drop` seront ajoutés à
	// DDL/2..DDL/4 pour add/drop column/index. `key` reste soft-ident,
	// contextuel après `primary`.
	"table",
	"primary",
	"unique",
	"nullable",
	"default"
]);

/** Alias de mots-clés normalisés à la lecture (ex. `take` → `limit`). */
export const KEYWORD_ALIASES: Readonly<Record<string, string>> = {
	take: "limit"
};

/**
 * Verbes d'introspection — soft-keywords contextuels (détectés au parser
 * en tête de statement uniquement, pour ne pas rentrer en conflit avec un
 * usage `pick x as list`/`as describe`). Absent de [[KEYWORDS]] à dessein —
 * mais highlightés comme des keywords côté éditeur.
 */
export const INTROSPECT_VERBS: ReadonlySet<string> = new Set([
	"list",
	"describe",
	// `for` — filter shortcut. Highlight comme keyword, mais reste
	// soft-keyword (utilisable en ident hors introspect).
	"for",
	// `raw` escape hatch — highlight bleu. Soft-keyword aussi.
	"raw",
	// `let` — CTE binding. Highlight bleu, soft-keyword.
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
