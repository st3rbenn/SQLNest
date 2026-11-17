import { type Token, tokenize } from "@sqlnest/snql";

export interface QueryTables {
	/** Table de départ (`find X`, `get X`, `update X`, `… into X`, `remove from X`). */
	readonly root: string | null;
	/** Tables jointes par `with … [and …]`, dans l'ordre d'écriture. */
	readonly joined: readonly string[];
}

const NONE: QueryTables = { root: null, joined: [] };
const ROOT_VERBS = new Set(["find", "get", "update"]);
const ROOT_PREPOSITIONS = new Set(["into", "from"]);
const JOIN_ARITY = new Set(["one", "many"]);
/** Étapes qui suivent les jointures : elles ferment la clause `with`. */
const AFTER_JOINS = new Set([
	"where",
	"group",
	"having",
	"pick",
	"sort",
	"limit",
	"set"
]);

/**
 * Tables qu'une requête touche, lues sur ses tokens plutôt que sur son
 * arbre : une requête en cours de frappe, que le parser refuserait, garde
 * ainsi son rattachement à sa table.
 */
export function queryTables(source: string): QueryTables {
	let tokens: Token[];
	try {
		tokens = tokenize(source);
	} catch {
		return NONE;
	}
	let root: string | null = null;
	const joined: string[] = [];
	// Dans la clause `with`, chaque `and` enchaîne une jointure ; ailleurs
	// (un `where`), c'est un opérateur logique.
	let inJoins = false;
	for (let i = 0; i < tokens.length; i++) {
		const word = tokens[i]?.value.toLowerCase();
		const next = tokens[i + 1];
		if (word === undefined || next === undefined) continue;
		if (
			root === null &&
			next.kind === "ident" &&
			(ROOT_VERBS.has(word) || ROOT_PREPOSITIONS.has(word))
		) {
			root = next.value;
			continue;
		}
		if (word === "with") inJoins = true;
		else if (AFTER_JOINS.has(word)) inJoins = false;
		if (!inJoins || (word !== "with" && word !== "and")) continue;
		// `one` / `many` forcent la multiplicité ; sans eux, elle est inférée.
		const table = JOIN_ARITY.has(next.value.toLowerCase())
			? tokens[i + 2]
			: next;
		if (table?.kind === "ident" && !joined.includes(table.value)) {
			joined.push(table.value);
		}
	}
	return root === null ? NONE : { root, joined };
}
