import type { TokenCursor } from "./cursor";

/**
 * Coups d'œil sur le prochain jeton, sans le consommer.
 */

export function peekKeyword(
	cursor: TokenCursor,
	value: string,
	ahead = 0
): boolean {
	const tok = cursor.peek(ahead);
	return tok.kind === "keyword" && tok.value === value;
}

/**
 * Peek soft-ident (kind === "ident" + value comparé case-insensitive) —
 * miroir peekKeyword pour les mots comme `column`, `unique`, `nullable`
 * qui restent idents pour ne pas casser un usage nom-de-champ ailleurs.
 */
export function peekIdent(
	cursor: TokenCursor,
	value: string,
	ahead = 0
): boolean {
	const tok = cursor.peek(ahead);
	return tok.kind === "ident" && tok.value.toLowerCase() === value;
}
