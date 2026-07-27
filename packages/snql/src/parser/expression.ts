import { SnqlError } from "../diagnostics";
import type { Span, Token } from "../lexer/token";
import type { CompareOperator, Expr } from "./ast";
import type { TokenCursor } from "./cursor";

const COMPARE_OPS: ReadonlySet<string> = new Set([
	"=",
	"!=",
	"<",
	">",
	"<=",
	">="
]);

/** Parse une expression complète (précédence gérée par un Pratt parser). */
export function parseExpression(cursor: TokenCursor): Expr {
	return parseExpr(cursor, 0);
}

/** Parse un chemin de champ `a.b.c` (identifiants séparés par des points). */
export function parseFieldPath(cursor: TokenCursor): {
	path: string[];
	span: Span;
} {
	const first = cursor.expect("ident", "un identifiant");
	const path: string[] = [first.value];
	let endSpan = first.span;
	while (cursor.peek().kind === "dot") {
		cursor.next();
		const part = cursor.expect("ident", "un identifiant après '.'");
		path.push(part.value);
		endSpan = part.span;
	}
	return { path, span: joinSpan(first.span, endSpan) };
}

function parseExpr(cursor: TokenCursor, minBindingPower: number): Expr {
	let left = parsePrefix(cursor);

	for (;;) {
		const tok = cursor.peek();
		const bp = infixBindingPower(tok);
		if (bp === null || bp < minBindingPower) {
			break;
		}

		if (tok.kind === "keyword" && (tok.value === "and" || tok.value === "or")) {
			cursor.next();
			const right = parseExpr(cursor, bp + 1);
			left = {
				type: "logical",
				operator: tok.value,
				left,
				right,
				span: joinSpan(left.span, right.span)
			};
		} else if (tok.kind === "keyword" && tok.value === "in") {
			cursor.next();
			const { values, endSpan } = parseInList(cursor);
			left = {
				type: "in",
				target: left,
				values,
				span: joinSpan(left.span, endSpan)
			};
		} else {
			// Comparaison (op) ou `like` (keyword).
			cursor.next();
			const right = parseExpr(cursor, bp + 1);
			const operator: CompareOperator =
				tok.kind === "keyword" ? "like" : (tok.value as CompareOperator);
			left = {
				type: "compare",
				operator,
				left,
				right,
				span: joinSpan(left.span, right.span)
			};
		}
	}

	return left;
}

function parsePrefix(cursor: TokenCursor): Expr {
	const tok = cursor.peek();

	if (tok.kind === "keyword" && tok.value === "not") {
		cursor.next();
		const operand = parseExpr(cursor, 3);
		return { type: "not", operand, span: joinSpan(tok.span, operand.span) };
	}
	// Signe unaire : uniquement devant un littéral numérique.
	if (tok.kind === "minus" || tok.kind === "plus") {
		cursor.next();
		const operand = parsePrefix(cursor);
		if (operand.type !== "literal" || operand.value.kind !== "number") {
			throw new SnqlError(
				"Un signe unaire ne s'applique qu'à un littéral numérique",
				"parse_unary_sign",
				joinSpan(tok.span, operand.span)
			);
		}
		const raw =
			tok.kind === "minus" ? negateRaw(operand.value.raw) : operand.value.raw;
		return {
			type: "literal",
			value: { kind: "number", raw },
			span: joinSpan(tok.span, operand.span)
		};
	}
	if (tok.kind === "lparen") {
		cursor.next();
		const inner = parseExpr(cursor, 0);
		cursor.expect("rparen", "')'");
		return inner;
	}
	if (tok.kind === "number") {
		cursor.next();
		return {
			type: "literal",
			value: { kind: "number", raw: tok.value },
			span: tok.span
		};
	}
	if (tok.kind === "string") {
		cursor.next();
		return {
			type: "literal",
			value: { kind: "string", value: tok.value },
			span: tok.span
		};
	}
	if (tok.kind === "boolean") {
		cursor.next();
		return {
			type: "literal",
			value: { kind: "boolean", value: tok.value === "true" },
			span: tok.span
		};
	}
	if (tok.kind === "null") {
		cursor.next();
		return { type: "literal", value: { kind: "null" }, span: tok.span };
	}
	if (tok.kind === "ident") {
		const { path, span } = parseFieldPath(cursor);
		return { type: "field", path, span };
	}

	throw new SnqlError(
		`Expression attendue, trouvé ${describe(tok)}`,
		"parse_expr_expected",
		tok.span
	);
}

function parseInList(cursor: TokenCursor): { values: Expr[]; endSpan: Span } {
	cursor.expect("lbracket", "'[' pour la liste de 'in'");
	const values: Expr[] = [];
	if (cursor.peek().kind !== "rbracket") {
		values.push(parseExpr(cursor, 0));
		while (cursor.peek().kind === "comma") {
			cursor.next();
			values.push(parseExpr(cursor, 0));
		}
	}
	const close = cursor.expect("rbracket", "']'");
	return { values, endSpan: close.span };
}

function infixBindingPower(tok: Token): number | null {
	if (tok.kind === "keyword") {
		if (tok.value === "or") {
			return 1;
		}
		if (tok.value === "and") {
			return 2;
		}
		if (tok.value === "in" || tok.value === "like") {
			return 4;
		}
	}
	if (tok.kind === "op" && COMPARE_OPS.has(tok.value)) {
		return 4;
	}
	return null;
}

/** Applique un signe '-' : `-x`→`-x`, `--x`→`x` (double négation). */
function negateRaw(raw: string): string {
	return raw.startsWith("-") ? raw.slice(1) : `-${raw}`;
}

function joinSpan(a: Span, b: Span): Span {
	return { start: a.start, end: b.end };
}

function describe(tok: Token): string {
	if (tok.kind === "eof") {
		return "la fin de l'entrée";
	}
	return `'${tok.value}'`;
}
