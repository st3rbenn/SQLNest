/** Position 0-based en offset, 1-based en ligne/colonne. */
export interface Position {
	readonly offset: number;
	readonly line: number;
	readonly column: number;
}

/** Intervalle source [start, end). */
export interface Span {
	readonly start: Position;
	readonly end: Position;
}

export type TokenKind =
	| "verb" // get / find / add / update / remove …
	| "keyword" // where, pick, sort, limit, and, or, not, in, like, asc, desc …
	| "ident" // identifiants (collections, champs, alias) — casse préservée
	| "number"
	| "string"
	| "boolean"
	| "null"
	| "op" // = != < > <= >=
	| "comma" // ,
	| "dot" // .
	| "plus" // +
	| "minus" // -
	| "lparen" // (
	| "rparen" // )
	| "lbracket" // [
	| "rbracket" // ]
	| "lbrace" // {
	| "rbrace" // }
	| "colon" // :
	| "eof";

export interface Token {
	readonly kind: TokenKind;
	readonly value: string;
	readonly span: Span;
}
