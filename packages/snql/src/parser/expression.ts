import { SnqlError } from "../diagnostics";
import type { Span, Token, TokenKind } from "../lexer/token";
import { CAST_TARGETS, MAX_LITERAL_DEPTH } from "./ast";
import type {
	ArithOperator,
	CastTarget,
	CompareOperator,
	Expr,
	ObjectEntry
} from "./ast";
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
	// Object literal en position d'expression (sprint object-literals).
	if (tok.kind === "lbrace") {
		return parseObjectLiteral(cursor, 0);
	}
	// Array literal en position d'expression. `where x in [...]` reste géré par
	// parseInList (Expr.in dédié pour le fast-path indexable Mongo).
	if (tok.kind === "lbracket") {
		return parseArrayLiteral(cursor, 0);
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

/**
 * Parse un object literal `{k: v, k: v, ...}` en position d'expression.
 * Autorise vide `{}`. Refuse : dup keys, depth > MAX_LITERAL_DEPTH,
 * clé non-ident/keyword/string. Réutilise `parseKeyValueEntry` — même
 * helper que côté insert (via wrapper dans parser.ts) pour DRY.
 */
export function parseObjectLiteral(cursor: TokenCursor, depth: number): Expr {
	if (depth >= MAX_LITERAL_DEPTH) {
		throw new SnqlError(
			`Profondeur d'imbrication object/array > ${MAX_LITERAL_DEPTH}`,
			"parse_object_literal_depth_exceeded",
			cursor.peek().span
		);
	}
	const open = cursor.expect("lbrace", "'{' pour ouvrir un object literal");
	const entries: ObjectEntry[] = [];
	const seenKeys = new Set<string>();
	if (cursor.peek().kind !== "rbrace") {
		for (;;) {
			const entry = parseKeyValueEntry(cursor, depth + 1);
			if (seenKeys.has(entry.key)) {
				throw new SnqlError(
					`Clé dupliquée '${entry.key}' dans l'object literal`,
					"parse_object_literal_duplicate_key",
					entry.keySpan
				);
			}
			seenKeys.add(entry.key);
			entries.push(entry);
			const next = cursor.peek();
			if (next.kind === "comma") {
				cursor.next();
				continue;
			}
			if (next.kind === "rbrace") {
				break;
			}
			throw new SnqlError(
				`',' ou '}' attendu, trouvé ${describe(next)}`,
				"parse_object_literal_close_expected",
				next.span
			);
		}
	}
	const close = cursor.expect("rbrace", "'}' pour fermer l'object literal");
	return { type: "object", entries, span: joinSpan(open.span, close.span) };
}

/**
 * Parse `key: value` — key ∈ {ident, keyword, string}. Export commun pour
 * parseInsertField (parser.ts wrapper produit InsertField {column, value}) et
 * parseObjectLiteral (produit ObjectEntry {key, keyQuoted, value, keySpan}).
 * Keywords acceptés en bare key (ex: `{from: 1, group: 2}`) — désambigüité
 * par position lbrace..colon (aucune ambiguïté avec expression Pratt).
 */
export function parseKeyValueEntry(
	cursor: TokenCursor,
	depth: number
): ObjectEntry {
	const key = cursor.peek();
	if (
		key.kind !== "ident" &&
		key.kind !== "keyword" &&
		key.kind !== "string"
	) {
		throw new SnqlError(
			`Clé attendue (identifiant, keyword ou string), trouvé ${describe(key)}`,
			"parse_object_literal_key_expected",
			key.span
		);
	}
	cursor.next();
	const colon = cursor.peek();
	if (colon.kind !== "colon") {
		throw new SnqlError(
			`':' attendu après la clé '${key.value}'`,
			"parse_object_literal_colon_expected",
			colon.span
		);
	}
	cursor.next();
	// Une value peut être object/array nested — parseExpr → parsePrefix
	// redispatch via lbrace/lbracket avec depth+1 (protection stack).
	const value = parseValueWithDepth(cursor, depth);
	return {
		key: key.value,
		keyQuoted: key.kind === "string",
		value,
		keySpan: key.span,
		span: joinSpan(key.span, value.span)
	};
}

/**
 * Parse une expression, mais si c'est un object/array literal, force le
 * `depth` transmis pour la protection contre stack overflow.
 */
function parseValueWithDepth(cursor: TokenCursor, depth: number): Expr {
	const tok = cursor.peek();
	if (tok.kind === "lbrace") return parseObjectLiteral(cursor, depth);
	if (tok.kind === "lbracket") return parseArrayLiteral(cursor, depth);
	return parseExpr(cursor, 0);
}

/**
 * Parse un array literal `[v, v, ...]` en position d'expression. Autorise
 * vide `[]`. Items peuvent être n'importe quelle expression (field, arith,
 * call, object nested, array nested...).
 */
export function parseArrayLiteral(cursor: TokenCursor, depth: number): Expr {
	if (depth >= MAX_LITERAL_DEPTH) {
		throw new SnqlError(
			`Profondeur d'imbrication object/array > ${MAX_LITERAL_DEPTH}`,
			"parse_array_literal_depth_exceeded",
			cursor.peek().span
		);
	}
	const open = cursor.expect("lbracket", "'[' pour ouvrir un array literal");
	const items: Expr[] = [];
	if (cursor.peek().kind !== "rbracket") {
		for (;;) {
			items.push(parseValueWithDepth(cursor, depth + 1));
			const next = cursor.peek();
			if (next.kind === "comma") {
				cursor.next();
				continue;
			}
			if (next.kind === "rbracket") {
				break;
			}
			throw new SnqlError(
				`',' ou ']' attendu, trouvé ${describe(next)}`,
				"parse_array_literal_close_expected",
				next.span
			);
		}
	}
	const close = cursor.expect("rbracket", "']' pour fermer l'array literal");
	return { type: "array", items, span: joinSpan(open.span, close.span) };
}
