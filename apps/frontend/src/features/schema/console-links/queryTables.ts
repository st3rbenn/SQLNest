import { type Token, tokenize } from "@sqlnest/snql";

export interface QueryTables {
	/** Table de départ (`find X`, `get X`, `update X`, `… into X`, `remove from X`). */
	readonly root: string | null;
	/** Tables jointes par `with one` / `with many`, dans l'ordre d'écriture. */
	readonly joined: readonly string[];
}

const NONE: QueryTables = { root: null, joined: [] };
const ROOT_VERBS = new Set(["find", "get", "update"]);
const ROOT_PREPOSITIONS = new Set(["into", "from"]);
const JOIN_ARITY = new Set(["one", "many"]);

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
		const after = tokens[i + 2];
		if (
			word === "with" &&
			JOIN_ARITY.has(next.value.toLowerCase()) &&
			after?.kind === "ident" &&
			!joined.includes(after.value)
		) {
			joined.push(after.value);
		}
	}
	return root === null ? NONE : { root, joined };
}
