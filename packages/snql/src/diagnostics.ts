import type { Span } from "./lexer/token";

/**
 * Erreur de compilation SNQL. Porte un code machine-lisible et,
 * quand c'est possible, la position source ([[Span]]) pour un diagnostic précis.
 */
export class SnqlError extends Error {
	readonly code: string;
	readonly span?: Span;

	constructor(message: string, code: string, span?: Span) {
		super(message);
		this.name = "SnqlError";
		this.code = code;
		if (span !== undefined) {
			this.span = span;
		}
	}
}
