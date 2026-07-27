import { SnqlError } from "../diagnostics";
import { KEYWORDS, verbOperation } from "./dictionary";
import type { Position, Span, Token, TokenKind } from "./token";

const isDigit = (c: string): boolean => c >= "0" && c <= "9";
const isIdentStart = (c: string): boolean =>
	(c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_";
const isIdentPart = (c: string): boolean => isIdentStart(c) || isDigit(c);

/** Ponctuation / opérateurs mono-caractère → kind de token. */
const SINGLE: Readonly<Record<string, TokenKind>> = {
	"|": "pipe",
	",": "comma",
	".": "dot",
	"(": "lparen",
	")": "rparen",
	"[": "lbracket",
	"]": "rbracket",
	"+": "plus",
	"-": "minus",
	"=": "op"
};

/** Transforme le texte SNQL en flux de tokens (terminé par un token `eof`). */
export function tokenize(source: string): Token[] {
	return new Lexer(source).run();
}

class Lexer {
	private readonly source: string;
	private offset = 0;
	private line = 1;
	private column = 1;
	private readonly tokens: Token[] = [];

	constructor(source: string) {
		this.source = source;
	}

	run(): Token[] {
		while (!this.atEnd()) {
			this.scanToken();
		}
		const end = this.pos();
		this.tokens.push({ kind: "eof", value: "", span: { start: end, end } });
		return this.tokens;
	}

	private atEnd(): boolean {
		return this.offset >= this.source.length;
	}

	private pos(): Position {
		return { offset: this.offset, line: this.line, column: this.column };
	}

	private peek(ahead = 0): string {
		return this.source[this.offset + ahead] ?? "";
	}

	private advance(): string {
		const c = this.source[this.offset] ?? "";
		this.offset += 1;
		if (c === "\n") {
			this.line += 1;
			this.column = 1;
		} else {
			this.column += 1;
		}
		return c;
	}

	private push(kind: TokenKind, value: string, start: Position): void {
		this.tokens.push({ kind, value, span: { start, end: this.pos() } });
	}

	private spanFrom(start: Position): Span {
		return { start, end: this.pos() };
	}

	private scanToken(): void {
		const c = this.peek();

		if (c === " " || c === "\t" || c === "\r" || c === "\n") {
			this.advance();
			return;
		}
		// Commentaire ligne : '#' jusqu'à la fin de ligne.
		if (c === "#") {
			while (!this.atEnd() && this.peek() !== "\n") {
				this.advance();
			}
			return;
		}

		const start = this.pos();

		if (this.scanPunctuation(c, start) || this.scanOperator(c, start)) {
			return;
		}
		if (c === '"' || c === "'") {
			this.scanString(start, c);
			return;
		}
		if (isDigit(c)) {
			this.scanNumber(start);
			return;
		}
		if (isIdentStart(c)) {
			this.scanWord(start);
			return;
		}

		this.advance();
		throw new SnqlError(
			`Caractère inattendu '${c}'`,
			"lex_unexpected",
			this.spanFrom(start)
		);
	}

	/** Ponctuation mono-caractère (voir SINGLE). Retourne true si consommé. */
	private scanPunctuation(c: string, start: Position): boolean {
		const kind = SINGLE[c];
		if (kind === undefined) {
			return false;
		}
		this.advance();
		this.push(kind, c, start);
		return true;
	}

	/** Opérateurs `!= < <= > >=`. Retourne true si consommé. */
	private scanOperator(c: string, start: Position): boolean {
		if (c === "!") {
			this.advance();
			if (this.peek() !== "=") {
				throw new SnqlError(
					"Caractère inattendu '!' (voulez-vous '!=' ?)",
					"lex_unexpected",
					this.spanFrom(start)
				);
			}
			this.advance();
			this.push("op", "!=", start);
			return true;
		}
		if (c === "<" || c === ">") {
			this.advance();
			if (this.peek() === "=") {
				this.advance();
				this.push("op", `${c}=`, start);
			} else {
				this.push("op", c, start);
			}
			return true;
		}
		return false;
	}

	private scanString(start: Position, quote: string): void {
		this.advance(); // guillemet ouvrant
		let value = "";
		while (!this.atEnd() && this.peek() !== quote) {
			if (this.peek() === "\\") {
				this.advance();
				value += unescapeChar(this.advance());
			} else {
				value += this.advance();
			}
		}
		if (this.atEnd()) {
			throw new SnqlError(
				"Chaîne de caractères non terminée",
				"lex_unterminated_string",
				this.spanFrom(start)
			);
		}
		this.advance(); // guillemet fermant
		this.tokens.push({ kind: "string", value, span: this.spanFrom(start) });
	}

	private scanNumber(start: Position): void {
		let raw = "";
		while (isDigit(this.peek())) {
			raw += this.advance();
		}
		// Fraction seulement si un chiffre suit le point (sinon '.' est un séparateur de chemin).
		if (this.peek() === "." && isDigit(this.peek(1))) {
			raw += this.advance();
			while (isDigit(this.peek())) {
				raw += this.advance();
			}
		}
		this.tokens.push({
			kind: "number",
			value: raw,
			span: this.spanFrom(start)
		});
	}

	private scanWord(start: Position): void {
		let raw = "";
		while (isIdentPart(this.peek())) {
			raw += this.advance();
		}
		const lower = raw.toLowerCase();
		let kind: TokenKind;
		if (lower === "true" || lower === "false") {
			kind = "boolean";
		} else if (lower === "null") {
			kind = "null";
		} else if (verbOperation(lower) !== undefined) {
			kind = "verb";
		} else if (KEYWORDS.has(lower)) {
			kind = "keyword";
		} else {
			kind = "ident";
		}
		// Verbes/mots-clés/littéraux sont normalisés en minuscules ;
		// les identifiants gardent leur casse (noms réels en base).
		const value = kind === "ident" ? raw : lower;
		this.tokens.push({ kind, value, span: this.spanFrom(start) });
	}
}

function unescapeChar(c: string): string {
	switch (c) {
		case "n":
			return "\n";
		case "t":
			return "\t";
		case "r":
			return "\r";
		case "\\":
			return "\\";
		case '"':
			return '"';
		case "'":
			return "'";
		default:
			return c;
	}
}
