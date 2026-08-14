import { SnqlError } from "../diagnostics";
import { SNQL_FUNCTIONS } from "../functions";
import type { Span, Token, TokenKind } from "../lexer/token";
import { CAST_TARGETS, MAX_CASE_DEPTH, MAX_LITERAL_DEPTH } from "./ast";
import type {
	ArithOperator,
	CaseBranch,
	CastTarget,
	CompareOperator,
	Expr,
	ObjectEntry,
	Query,
	SortKey
} from "./ast";
import type { TokenCursor } from "./cursor";

/**
 * Sprint T2/11 : hook pour parser une sub-query. Évite la dép circulaire
 * expression.ts ↔ parser.ts (parseSelect vit dans parser.ts). Parser.ts fait
 * `setSubqueryParser(parseStatement)` au module load. La sub-query doit être
 * une Query (verb `find`/`get`), pas une mutation.
 */
let subqueryParser: ((cursor: TokenCursor) => Query) | null = null;
export function setSubqueryParser(fn: (cursor: TokenCursor) => Query): void {
	subqueryParser = fn;
}

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
			// Sprint T2/11 : `in (find ...)` sub-query vs `in [...]` value list.
			// Discriminant : `(` + verb dedans = subquery ; `[` = value list.
			const next = cursor.peek();
			if (next.kind === "lparen" && cursor.peek(1).kind === "verb") {
				const subq = parseSubqueryParen(cursor);
				left = {
					type: "in",
					target: left,
					values: [subq],
					span: joinSpan(left.span, subq.span)
				};
			} else {
				const { values, endSpan } = parseInList(cursor);
				left = {
					type: "in",
					target: left,
					values,
					span: joinSpan(left.span, endSpan)
				};
			}
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
	// Sprint T2/11 : `exists (find ...)` — prefix keyword. Exige `(` + verb
	// dedans (subquery obligatoire, pas une expression scalaire).
	if (tok.kind === "keyword" && tok.value === "exists") {
		cursor.next();
		if (cursor.peek().kind !== "lparen") {
			throw new SnqlError(
				"'exists' attend '(find ...)' — la sub-query doit être entre parens",
				"parse_exists_missing_paren",
				cursor.peek().span
			);
		}
		if (cursor.peek(1).kind !== "verb") {
			throw new SnqlError(
				"'exists (...)' attend une sub-query (verb 'find'/'get' après '(')",
				"parse_exists_not_subquery",
				cursor.peek().span
			);
		}
		const subq = parseSubqueryParen(cursor);
		return {
			type: "exists",
			subquery: subq,
			span: joinSpan(tok.span, subq.span)
		};
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
		// Sprint T2/5 : `case { … }` en position d'expression. `case` reste ident
		// hors de cette position (pattern `cast` sprint 2) — utilisable comme
		// colonne. La détection exige le `lbrace` immédiatement après le ident
		// `case` (via lookahead 1). Sans ce guard, `pick case`, `where case = 42`,
		// `case.foo` restent des fields normaux.
		if (
			tok.value.toLowerCase() === "case" &&
			cursor.peek(1).kind === "lbrace"
		) {
			return parseCaseBlock(cursor);
		}
		const { path, span } = parseFieldPath(cursor);
		// Postfix `(` sur un ident nu = appel de fonction. Requiert un chemin de
		// longueur 1 : `x.y(...)` n'est pas un call (pas de méthode SNQL) — reste
		// donc un field. Les parens sont obligatoires ; 0 arg = `now()`.
		if (path.length === 1 && cursor.peek().kind === "lparen") {
			const call = parseCall(cursor, path[0] as string, span);
			// Sprint T2/9 : postfix `over (...)` sur un call déclaré window
			// dans le registre. Refuse `over` sur non-window (message clair).
			if (
				call.type === "call" &&
				cursor.peek().kind === "keyword" &&
				cursor.peek().value === "over"
			) {
				return parseWindowClause(cursor, call);
			}
			return call;
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
 *
 * Sprint T2/6 : fast-paths agrégats scalaires.
 *  - `count(*)` : star token scopé aux args de call. Refus structurel
 *    sum(*)/avg(*) au parser (`parse_call_star_only_count`) — l'étoile reste
 *    multiplication ailleurs (isArithToken).
 *  - `count(unique x)` : soft-keyword `unique` (aligné `pick unique` sprint 10).
 *    Discriminator : p0=ident('unique'), p1 démarre une expression → fast-path.
 *    p1=rparen → `parse_call_unique_missing_arg` (piège UX vs field 'unique').
 *    `distinct` en position modifier → `parse_call_distinct_use_unique` (hint
 *    'utilise unique' — SNQL cohérence).
 */
function parseCall(cursor: TokenCursor, rawName: string, nameSpan: Span): Expr {
	const name = rawName.toLowerCase();
	if (name === "cast") {
		return parseCastBody(cursor, nameSpan);
	}
	cursor.next(); // consomme la '('

	const p0 = cursor.peek();

	// Fast-path 1 : star (count(*)) — refus structurel sum(*)/avg(*)/etc.
	if (p0.kind === "star") {
		if (name !== "count") {
			throw new SnqlError(
				`'${name}(*)' — '*' est réservé à count(*)`,
				"parse_call_star_only_count",
				p0.span
			);
		}
		cursor.next(); // consomme star
		const after = cursor.peek();
		if (after.kind === "comma") {
			throw new SnqlError(
				"count(*) — pas d'argument supplémentaire après '*'",
				"parse_call_star_with_extra_args",
				after.span
			);
		}
		const close = cursor.expect("rparen", "')' pour fermer count(*)");
		return {
			type: "call",
			name,
			args: [],
			star: true,
			span: joinSpan(nameSpan, close.span)
		};
	}

	// Fast-path 2 : soft-keyword modifier `unique` / `distinct` (hint).
	if (p0.kind === "ident") {
		const modLower = p0.value.toLowerCase();
		if (modLower === "unique" || modLower === "distinct") {
			const p1 = cursor.peek(1);
			// p1 doit démarrer une expression (ident/literal/parens/unary/composite).
			const isExprStart =
				p1.kind === "ident" ||
				p1.kind === "lparen" ||
				p1.kind === "number" ||
				p1.kind === "string" ||
				p1.kind === "boolean" ||
				p1.kind === "null" ||
				p1.kind === "lbrace" ||
				p1.kind === "lbracket" ||
				p1.kind === "minus" ||
				p1.kind === "plus";
			if (isExprStart) {
				if (modLower === "distinct") {
					throw new SnqlError(
						`SNQL utilise 'unique' au lieu de 'distinct' — écris '${name}(unique ...)'`,
						"parse_call_distinct_use_unique",
						p0.span
					);
				}
				// modifier === 'unique' → fast-path.
				cursor.next(); // consomme ident 'unique'
				const args: Expr[] = [parseExpr(cursor, 0)];
				// Sprint T2/8 : aggregateMulti (string_agg) a un 2e arg
				// (separator) après `unique`. Aggregate scalar reste mono-arg
				// (count/sum/avg/min/max), refuse args supplémentaires.
				const entry = SNQL_FUNCTIONS.get(name);
				const isAggMulti = entry?.kind === "aggregateMulti";
				if (isAggMulti) {
					while (cursor.peek().kind === "comma") {
						cursor.next();
						args.push(parseExpr(cursor, 0));
					}
				}
				const after = cursor.peek();
				if (after.kind === "comma") {
					throw new SnqlError(
						`'${name}(unique ...)' — arité mono-arg cross-engine (pas d'argument supplémentaire)`,
						"parse_call_unique_extra_args",
						after.span
					);
				}
				// Sprint T2/8 : sort intra-call après args, si aggregateMulti.
				let sortKeys: SortKey[] | undefined;
				const afterArgs = cursor.peek();
				if (
					isAggMulti &&
					afterArgs.kind === "keyword" &&
					afterArgs.value === "sort"
				) {
					cursor.next();
					sortKeys = [parseIntraCallSortKey(cursor)];
					while (cursor.peek().kind === "comma") {
						cursor.next();
						sortKeys.push(parseIntraCallSortKey(cursor));
					}
				}
				const close = cursor.expect(
					"rparen",
					`')' pour fermer '${name}(unique ...)'`
				);
				return {
					type: "call",
					name,
					args,
					unique: true,
					...(sortKeys !== undefined ? { sortKeys } : {}),
					span: joinSpan(nameSpan, close.span)
				};
			}
			if (p1.kind === "rparen") {
				// `count(unique)` nu — piège UX (silent count sur champ 'unique').
				// L'user avec un champ nommé 'unique' doit préfixer (`count(t.unique)`).
				throw new SnqlError(
					`'${name}(${modLower})' — expression manquante après '${modLower}' (attend '${name}(unique <expression>)')`,
					"parse_call_unique_missing_arg",
					p0.span
				);
			}
			// Fallback : p1 est un token qui ne peut pas démarrer une expression —
			// laisse parseExpr échouer avec son propre message générique.
		}
	}

	// Path standard : args normaux (n-ary comma-separated).
	const args: Expr[] = [];
	if (cursor.peek().kind !== "rparen") {
		args.push(parseExpr(cursor, 0));
		while (cursor.peek().kind === "comma") {
			cursor.next();
			args.push(parseExpr(cursor, 0));
		}
	}
	// Sprint T2/8 : sort intra-call — accepté UNIQUEMENT pour aggregateMulti
	// (array_agg / string_agg / json_agg). Parser contextuel via registre : si
	// le nom n'est pas déclaré aggregateMulti, la keyword `sort` reste un stage
	// keyword classique et la parenthèse fermante manquera → erreur claire.
	let sortKeys: SortKey[] | undefined;
	const afterArgs = cursor.peek();
	if (afterArgs.kind === "keyword" && afterArgs.value === "sort") {
		const entry = SNQL_FUNCTIONS.get(name);
		if (entry?.kind === "aggregateMulti") {
			cursor.next(); // consomme 'sort'
			sortKeys = [parseIntraCallSortKey(cursor)];
			while (cursor.peek().kind === "comma") {
				cursor.next();
				sortKeys.push(parseIntraCallSortKey(cursor));
			}
		}
	}
	const close = cursor.expect("rparen", "')' pour fermer l'appel de fonction");
	return {
		type: "call",
		name,
		args,
		...(sortKeys !== undefined ? { sortKeys } : {}),
		span: joinSpan(nameSpan, close.span)
	};
}

/**
 * Sprint T2/8 : parse une sort key intra-call — même shape que parseSortKey
 * du stage `sort`, mais isolé pour ne pas créer de dép cyclique parser↔parser.
 * `<path> [asc|desc]`.
 */
function parseIntraCallSortKey(cursor: TokenCursor): SortKey {
	const { path, span } = parseFieldPath(cursor);
	let direction: "asc" | "desc" = "asc";
	let endSpan = span;
	const p = cursor.peek();
	if (p.kind === "keyword" && (p.value === "asc" || p.value === "desc")) {
		const dirTok = cursor.next();
		direction = dirTok.value === "desc" ? "desc" : "asc";
		endSpan = dirTok.span;
	}
	return { path, direction, span: joinSpan(span, endSpan) };
}

/**
 * Sprint T2/9 : parse la clause `over (partition <col>[, <col>]* sort <key>[,
 * <key>]*)`. Appelé quand `over` détecté après un `call` — vérifie que le
 * name est déclaré `window` dans le registre, sinon message clair.
 *
 * Parts (partition, sort) sont toutes deux optionnelles ; les deux vides =
 * OVER () valide (window sur toute la relation, row_number global).
 */
function parseWindowClause(cursor: TokenCursor, call: Expr & { type: "call" }): Expr {
	const entry = SNQL_FUNCTIONS.get(call.name);
	if (entry?.kind !== "window") {
		throw new SnqlError(
			`'over' réservé aux window functions ; '${call.name}' est ${entry?.kind ?? "inconnu"} — retire 'over (...)' ou utilise row_number()/rank()/dense_rank()`,
			"parse_over_not_window",
			cursor.peek().span
		);
	}
	cursor.next(); // consomme 'over'
	cursor.expect("lparen", "'(' après 'over'");
	const partitionKeys: (readonly string[])[] = [];
	const sortKeys: SortKey[] = [];
	// `partition <col>[, <col>]*` — optionnel
	const p0 = cursor.peek();
	if (p0.kind === "keyword" && p0.value === "partition") {
		cursor.next();
		partitionKeys.push(parseFieldPath(cursor).path);
		while (cursor.peek().kind === "comma") {
			cursor.next();
			partitionKeys.push(parseFieldPath(cursor).path);
		}
	}
	// `sort <key>[, <key>]*` — optionnel, peut suivre partition ou être seul
	const p1 = cursor.peek();
	if (p1.kind === "keyword" && p1.value === "sort") {
		cursor.next();
		sortKeys.push(parseIntraCallSortKey(cursor));
		while (cursor.peek().kind === "comma") {
			cursor.next();
			sortKeys.push(parseIntraCallSortKey(cursor));
		}
	}
	const close = cursor.expect("rparen", "')' pour fermer 'over (...)'");
	return {
		type: "windowCall",
		name: call.name,
		args: call.args,
		partitionKeys,
		sortKeys,
		span: joinSpan(call.span, close.span)
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

/**
 * Sprint T2/11 : parse `(find/get ...)` en position d'expression. Consomme
 * la lparen, délègue au subqueryParser hook (parser.ts:parseStatement) qui
 * parse un full Query, puis expect rparen.
 */
function parseSubqueryParen(cursor: TokenCursor): Expr & { type: "subquery" } {
	if (subqueryParser === null) {
		throw new Error(
			"Sub-query parser hook non initialisé — parser.ts doit appeler setSubqueryParser au module load"
		);
	}
	const open = cursor.expect("lparen", "'(' pour ouvrir la sub-query");
	const query = subqueryParser(cursor);
	const close = cursor.expect("rparen", "')' pour fermer la sub-query");
	return {
		type: "subquery",
		query,
		span: joinSpan(open.span, close.span)
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

/**
 * Parse `case { c1 -> v1, c2 -> v2, else -> v3 }` en position d'expression.
 * Le token ident 'case' a déjà été détecté par parsePrefix via lookahead
 * sur lbrace — cette fn consomme 'case' puis le block.
 *
 * Contrat :
 *  - Min 1 branche condition (`case { else -> v }` refusé — utiliser `if`)
 *  - `else -> v` OBLIGATOIRE et forcément en dernier
 *  - `else` reste ident hors position bare-tête-de-branche (soft-keyword)
 *  - Depth guard MAX_CASE_DEPTH = 32 (protection stack overflow)
 */
export function parseCaseBlock(cursor: TokenCursor): Expr {
	return parseCaseBlockAtDepth(cursor, 0);
}

function parseCaseBlockAtDepth(cursor: TokenCursor, depth: number): Expr {
	if (depth >= MAX_CASE_DEPTH) {
		throw new SnqlError(
			`Profondeur d'imbrication case > ${MAX_CASE_DEPTH}`,
			"parse_case_depth_exceeded",
			cursor.peek().span
		);
	}
	const caseTok = cursor.next(); // consomme 'case'
	cursor.expect("lbrace", "'{' pour ouvrir 'case'");
	const branches: CaseBranch[] = [];
	let elseValue: Expr | undefined;
	if (cursor.peek().kind !== "rbrace") {
		for (;;) {
			const head = cursor.peek();
			// Détection soft-keyword `else` : ident 'else' suivi de `->`.
			// Sans le check peek(1)=arrow, `case { alias.else -> x }` casserait.
			if (
				head.kind === "ident" &&
				head.value.toLowerCase() === "else" &&
				cursor.peek(1).kind === "arrow"
			) {
				cursor.next(); // consomme 'else'
				cursor.expect(
					"arrow",
					"'->' attendu après 'else' (pas d'espace entre - et >)"
				);
				elseValue = parseCaseBranchValue(cursor, depth);
				// Else DOIT être la dernière branche — comma-then-anything refusé.
				const after = cursor.peek();
				if (after.kind !== "rbrace") {
					throw new SnqlError(
						"'else' doit être la dernière branche du 'case'",
						"parse_case_else_not_last",
						after.span
					);
				}
				break;
			}
			// Branche condition normale : parseExpr → arrow → parseExpr.
			const cond = parseExpr(cursor, 0);
			const arrowTok = cursor.peek();
			if (arrowTok.kind !== "arrow") {
				throw new SnqlError(
					"'->' attendu entre condition et valeur (pas d'espace entre - et >)",
					"parse_case_missing_arrow",
					arrowTok.span
				);
			}
			cursor.next(); // consomme arrow
			const value = parseCaseBranchValue(cursor, depth);
			branches.push({ cond, value, span: joinSpan(cond.span, value.span) });
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
				"parse_case_close_expected",
				next.span
			);
		}
	}
	const close = cursor.expect("rbrace", "'}' pour fermer 'case'");
	if (branches.length === 0) {
		throw new SnqlError(
			"'case' sans branche condition — utilise directement la valeur ou 'if(c, a, b)' pour une seule condition",
			"parse_case_no_branches",
			joinSpan(caseTok.span, close.span)
		);
	}
	if (elseValue === undefined) {
		throw new SnqlError(
			"'else -> <valeur>' obligatoire dans 'case' — ajoute une branche par défaut",
			"parse_case_missing_else",
			joinSpan(caseTok.span, close.span)
		);
	}
	return {
		type: "case",
		branches,
		elseValue,
		span: joinSpan(caseTok.span, close.span)
	};
}

/**
 * Parse la valeur (RHS du `->`) d'une branche `case`. Bascule sur
 * parseCaseBlockAtDepth+1 si la valeur est elle-même un `case { … }` pour
 * propager le depth guard. Sinon parseExpr(0) standard.
 */
function parseCaseBranchValue(cursor: TokenCursor, depth: number): Expr {
	const head = cursor.peek();
	if (
		head.kind === "ident" &&
		head.value.toLowerCase() === "case" &&
		cursor.peek(1).kind === "lbrace"
	) {
		return parseCaseBlockAtDepth(cursor, depth + 1);
	}
	return parseExpr(cursor, 0);
}
