import { SnqlError } from "../diagnostics";
import type { Span, Token, TokenKind } from "../lexer/token";
import { CAST_TARGETS } from "./ast";
import type { ArithOperator, CastTarget, CompareOperator, Expr } from "./ast";
import type { TokenCursor } from "./cursor";

const COMPARE_OPS: ReadonlySet<string> = new Set([
	"=",
	"!=",
	"<",
	">",
	"<=",
	">="
]);

const ARITH_OP: Readonly<Record<string, ArithOperator>> = {
	plus: "+",
	minus: "-",
	star: "*",
	slash: "/",
	percent: "%"
};

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
		} else if (isArithToken(tok)) {
			// Arithmétique binaire : `+ - * / %`. Left-associatif via `bp + 1`.
			cursor.next();
			const right = parseExpr(cursor, bp + 1);
			left = {
				type: "arith",
				operator: ARITH_OP[tok.kind] as ArithOperator,
				left,
				right,
				span: joinSpan(left.span, right.span)
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
		// Postfix `(` sur un ident nu = appel de fonction. Requiert un chemin de
		// longueur 1 : `x.y(...)` n'est pas un call (pas de méthode SNQL) — reste
		// donc un field. Les parens sont obligatoires ; 0 arg = `now()`.
		if (path.length === 1 && cursor.peek().kind === "lparen") {
			return parseCall(cursor, path[0] as string, span);
		}
		return { type: "field", path, span };
	}

	throw new SnqlError(
		`Expression attendue, trouvé ${describe(tok)}`,
		"parse_expr_expected",
		tok.span
	);
}

/**
 * Parse le corps d'un appel de fonction : `(` [expr (`,` expr)*] `)`. Le nom a
 * déjà été consommé par parsePrefix ; on est positionné sur la `(`. Case-
 * normalise le nom en lowercase pour aligner avec le lookup registre. Dispatch
 * spécial `cast(...)` en tête : surface `cast(expr as T)` avec `as` interne
 * (ne remonte jamais au Pratt).
 */
function parseCall(cursor: TokenCursor, rawName: string, nameSpan: Span): Expr {
	const name = rawName.toLowerCase();
	if (name === "cast") {
		return parseCastBody(cursor, nameSpan);
	}
	cursor.next(); // consomme la '('
	const args: Expr[] = [];
	if (cursor.peek().kind !== "rparen") {
		args.push(parseExpr(cursor, 0));
		while (cursor.peek().kind === "comma") {
			cursor.next();
			args.push(parseExpr(cursor, 0));
		}
	}
	const close = cursor.expect("rparen", "')' pour fermer l'appel de fonction");
	return {
		type: "call",
		name,
		args,
		span: joinSpan(nameSpan, close.span)
	};
}

/**
 * Parse le corps de `cast(expr as T)` — appelé quand `parseCall` détecte le
 * nom `cast` (case-insensitive). `cast` reste un identifiant valide hors de
 * cette position, donc une colonne nommée `cast` continue de marcher — c'est
 * seulement la construction `cast(` qui bascule ici.
 */
function parseCastBody(cursor: TokenCursor, nameSpan: Span): Expr {
	cursor.next(); // consomme la '('
	if (cursor.peek().kind === "rparen") {
		throw new SnqlError(
			"'cast' attend 'expr as type' — exemple: cast(x as int)",
			"parse_cast_empty",
			cursor.peek().span
		);
	}
	const operand = parseExpr(cursor, 0);
	const afterOperand = cursor.peek();
	if (afterOperand.kind === "comma") {
		throw new SnqlError(
			"'cast' n'a qu'un opérande — utilise `as` : cast(price_str as float)",
			"parse_cast_comma_before_as",
			afterOperand.span
		);
	}
	if (!(afterOperand.kind === "keyword" && afterOperand.value === "as")) {
		throw new SnqlError(
			"'cast' attend 'expr as type' — exemple: cast(x as int)",
			"parse_cast_missing_as",
			afterOperand.span
		);
	}
	cursor.next(); // consomme 'as'
	const targetTok = cursor.peek();
	if (targetTok.kind !== "ident") {
		throw new SnqlError(
			"Type attendu après 'as' — canoniques: int, float, text, bool, date, timestamp, json",
			"parse_cast_target_expected",
			targetTok.span
		);
	}
	cursor.next();
	const targetName = targetTok.value.toLowerCase();
	if (!CAST_TARGETS.has(targetName as CastTarget)) {
		throw new SnqlError(
			`Type '${targetTok.value}' inconnu — canoniques: int, float, text, bool, date, timestamp, json`,
			"parse_cast_target_unknown",
			targetTok.span
		);
	}
	const afterTarget = cursor.peek();
	if (afterTarget.kind === "comma") {
		throw new SnqlError(
			"'cast' n'accepte qu'un type après 'as' — pas d'arguments supplémentaires",
			"parse_cast_extra_args",
			afterTarget.span
		);
	}
	const close = cursor.expect("rparen", "')' pour fermer 'cast'");
	return {
		type: "cast",
		operand,
		target: targetName as CastTarget,
		targetSpan: targetTok.span,
		span: joinSpan(nameSpan, close.span)
	};
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
	// Arithmétique : `+ -` bp 5, `* / %` bp 6 — au-dessus des comparaisons pour
	// que `age * 2 > 30` groupe naturellement en `(age * 2) > 30`.
	if (tok.kind === "plus" || tok.kind === "minus") {
		return 5;
	}
	if (tok.kind === "star" || tok.kind === "slash" || tok.kind === "percent") {
		return 6;
	}
	return null;
}

function isArithToken(tok: Token): boolean {
	const kind: TokenKind = tok.kind;
	return (
		kind === "plus" ||
		kind === "minus" ||
		kind === "star" ||
		kind === "slash" ||
		kind === "percent"
	);
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
