import { SnqlError } from "../diagnostics";
import type { Token, TokenKind } from "../lexer/token";

/** Curseur sur le flux de tokens, partagé par le parser et le parseur d'expressions. */
export class TokenCursor {
	private readonly tokens: readonly Token[];
	private index = 0;

	constructor(tokens: readonly Token[]) {
		if (tokens.length === 0) {
			throw new SnqlError("Flux de tokens vide", "parse_empty_stream");
		}
		this.tokens = tokens;
	}

	/** Token courant (ou N en avant). Bloque sur le dernier token (`eof`) au-delà de la fin. */
	peek(ahead = 0): Token {
		const i = this.index + ahead;
		const clamped = i < this.tokens.length ? i : this.tokens.length - 1;
		// Sûr : le tableau est non vide et `clamped` est dans les bornes.
		return this.tokens[clamped] as Token;
	}

	next(): Token {
		const tok = this.peek();
		if (this.index < this.tokens.length - 1) {
			this.index += 1;
		}
		return tok;
	}

	expect(kind: TokenKind, description: string): Token {
		const tok = this.peek();
		if (tok.kind !== kind) {
			throw new SnqlError(
				`Attendu ${description}, trouvé ${describe(tok)}`,
				"parse_unexpected",
				tok.span
			);
		}
		return this.next();
	}
}

function describe(tok: Token): string {
	if (tok.kind === "eof") {
		return "la fin de l'entrée";
	}
	return `'${tok.value}'`;
}
