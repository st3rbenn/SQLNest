import { SnqlError } from "../diagnostics";
import { verbOperation } from "../lexer/dictionary";
import type { Token } from "../lexer/token";
import type {
	FieldSelection,
	GroupKey,
	Query,
	SortKey,
	Source,
	Stage
} from "./ast";
import type { TokenCursor } from "./cursor";
import {
	parseExpression,
	parseFieldPath,
	setSubqueryParser
} from "./expression";
import { peekKeyword } from "./parser-peek";

/**
 * Requêtes de lecture : source, jointures `with`, puis les étapes dans leur
 * ordre (`where`, `group by`, `having`, `pick`, `sort`, `limit`).
 */

/** Mots-clés de stage d'un select, dans l'ordre canonique imposé. */
const SELECT_STAGE_ORDER = [
	"with",
	"where",
	"group",
	"having",
	"pick",
	"sort",
	"limit"
] as const;

const SELECT_STAGE_KEYWORDS: ReadonlySet<string> = new Set(SELECT_STAGE_ORDER);

export function parseSelect(cursor: TokenCursor, verbTok: Token): Query {
	const source = parseSource(cursor);
	const stages: Stage[] = [];

	if (peekKeyword(cursor, "with")) {
		stages.push(...parseWiths(cursor));
	}
	if (peekKeyword(cursor, "where")) {
		stages.push(parseWhere(cursor));
	}
	if (peekKeyword(cursor, "group")) {
		stages.push(parseGroupBy(cursor));
	}
	if (peekKeyword(cursor, "having")) {
		stages.push(parseHaving(cursor));
	}
	if (peekKeyword(cursor, "pick")) {
		stages.push(parsePick(cursor));
	}
	if (peekKeyword(cursor, "sort")) {
		stages.push(parseSort(cursor));
	}
	if (peekKeyword(cursor, "limit")) {
		stages.push(parseLimit(cursor));
	}

	rejectTrailingStage(cursor, SELECT_STAGE_KEYWORDS, SELECT_STAGE_ORDER);

	const lastStage = stages[stages.length - 1];
	const endSpan = lastStage ? lastStage.span : source.span;
	return {
		operation: "select",
		verb: verbTok.value,
		source,
		stages,
		span: { start: verbTok.span.start, end: endSpan.end }
	};
}

/**
 * Un keyword de stage encore là après le parsing = ordre non respecté ou clause
 * dupliquée. L'ordre est figé pour rendre les erreurs prévisibles : on nomme
 * l'attendu plutôt qu'un « inattendu » cryptique.
 */
export function rejectTrailingStage(
	cursor: TokenCursor,
	stageKeywords: ReadonlySet<string>,
	order: readonly string[]
): void {
	const trailing = cursor.peek();
	if (trailing.kind === "keyword" && stageKeywords.has(trailing.value)) {
		throw new SnqlError(
			`Étape '${trailing.value}' hors ordre ou dupliquée. Ordre attendu : ${order.join(" → ")}.`,
			"parse_stage_out_of_order",
			trailing.span
		);
	}
}

function parseSource(cursor: TokenCursor): Source {
	const nameTok = cursor.expect("ident", "un nom de collection");
	let endSpan = nameTok.span;
	let alias: string | undefined;
	if (cursor.peek().kind === "keyword" && cursor.peek().value === "as") {
		cursor.next();
		const aliasTok = cursor.expect("ident", "un alias après 'as'");
		alias = aliasTok.value;
		endSpan = aliasTok.span;
	}
	const span = { start: nameTok.span.start, end: endSpan.end };
	return alias !== undefined
		? { collection: nameTok.value, alias, span }
		: { collection: nameTok.value, span };
}

/**
 * Un ou plusieurs joins : `with A on … [and B on … [and …]]`. Le premier `with`
 * introduit la clause ; les suivants sont enchaînés par `and` seul (le mot
 * `with` n'est pas répété, cf. grammaire figée).
 */
export function parseWiths(cursor: TokenCursor): Stage[] {
	const withTok = cursor.next(); // 'with'
	const stages: Stage[] = [parseJoinClause(cursor, withTok)];
	while (peekKeyword(cursor, "and")) {
		const andTok = cursor.next();
		stages.push(parseJoinClause(cursor, andTok));
	}
	return stages;
}

function parseJoinClause(cursor: TokenCursor, startTok: Token): Stage {
	// `with one X on …` / `with many X on …` : escape hatch qui force la
	// multiplicité. Sans mot-clé, le lower infère depuis le schéma.
	let multiplicity: "one" | "many" | undefined;
	if (peekKeyword(cursor, "one") || peekKeyword(cursor, "many")) {
		multiplicity = cursor.next().value as "one" | "many";
	}
	const collection = cursor.expect("ident", "un nom de collection à joindre");
	let alias: string | undefined;
	if (peekKeyword(cursor, "as")) {
		cursor.next();
		alias = cursor.expect("ident", "un alias après 'as'").value;
	}
	if (!peekKeyword(cursor, "on")) {
		throw new SnqlError(
			"'with' attend une condition : on <champ local> = <champ distant>",
			"parse_with_missing_on",
			cursor.peek().span
		);
	}
	cursor.next(); // 'on'
	const { path: localField } = parseFieldPath(cursor);
	const eq = cursor.peek();
	if (!(eq.kind === "op" && eq.value === "=")) {
		throw new SnqlError(
			"Condition de join attendue : <champ local> = <champ distant>",
			"parse_with_condition",
			eq.span
		);
	}
	cursor.next(); // '='
	const foreign = parseFieldPath(cursor);
	const span = { start: startTok.span.start, end: foreign.span.end };
	const base = {
		type: "with" as const,
		collection: collection.value,
		localField,
		foreignField: foreign.path,
		span
	};
	return {
		...base,
		...(alias !== undefined ? { alias } : {}),
		...(multiplicity !== undefined ? { multiplicity } : {})
	};
}

export function parseWhere(cursor: TokenCursor): Stage {
	const kw = cursor.next();
	const predicate = parseExpression(cursor);
	return {
		type: "where",
		predicate,
		span: { start: kw.span.start, end: predicate.span.end }
	};
}

function parseGroupBy(cursor: TokenCursor): Stage {
	const kw = cursor.next(); // 'group'
	if (!peekKeyword(cursor, "by")) {
		throw new SnqlError(
			"'group' attend 'by' — écris 'group by <champ>, ...'",
			"parse_group_missing_by",
			cursor.peek().span
		);
	}
	cursor.next(); // 'by'
	const keys: GroupKey[] = [parseGroupKey(cursor)];
	while (cursor.peek().kind === "comma") {
		cursor.next();
		keys.push(parseGroupKey(cursor));
	}
	const last = keys[keys.length - 1];
	const end = last ? last.span.end : kw.span.end;
	return { type: "group", keys, span: { start: kw.span.start, end } };
}

function parseGroupKey(cursor: TokenCursor): GroupKey {
	const { path, span } = parseFieldPath(cursor);
	return { path, span };
}

function parseHaving(cursor: TokenCursor): Stage {
	const kw = cursor.next(); // 'having'
	const predicate = parseExpression(cursor);
	return {
		type: "having",
		predicate,
		span: { start: kw.span.start, end: predicate.span.end }
	};
}

export function parsePick(cursor: TokenCursor): Stage {
	const kw = cursor.next();
	// détecte `unique` (ident soft-keyword) + optional `on (keys)`.
	// Piège UX : un champ nommé `unique` reste valide (`pick unique` seul, sans
	// autre field derrière — mais ambigu !). On applique la règle : `unique`
	// SEULEMENT si suivi de `on` OU d'un ident qui n'est pas une continuation
	// possible (comma/eof/keyword). Sinon c'est un field.
	let unique: true | undefined;
	let distinctOnKeys: (readonly string[])[] | undefined;
	const p0 = cursor.peek();
	if (p0.kind === "ident" && p0.value.toLowerCase() === "unique") {
		const p1 = cursor.peek(1);
		// `unique` reconnu comme modifier si :
		//  - suivi de `on` keyword (variant DISTINCT ON), OU
		//  - suivi d'un ident/lparen/etc qui démarre une expression (variant
		//    DISTINCT sur les fields qui suivent).
		const isModifier =
			(p1.kind === "keyword" && p1.value === "on") ||
			p1.kind === "ident" ||
			p1.kind === "lparen" ||
			p1.kind === "lbrace" ||
			p1.kind === "lbracket";
		if (isModifier) {
			cursor.next(); // consomme ident 'unique'
			unique = true;
			// `on (k1, k2, ...)` — parens obligatoires, keys sont des field paths.
			if (peekKeyword(cursor, "on")) {
				cursor.next();
				cursor.expect(
					"lparen",
					"'(' après 'unique on' — les keys DISTINCT ON sont entre parens"
				);
				const keys: (readonly string[])[] = [parseFieldPath(cursor).path];
				while (cursor.peek().kind === "comma") {
					cursor.next();
					keys.push(parseFieldPath(cursor).path);
				}
				cursor.expect("rparen", "')' pour fermer 'unique on (...)'");
				distinctOnKeys = keys;
			}
		}
	}
	const fields: FieldSelection[] = [parseFieldSelection(cursor)];
	while (cursor.peek().kind === "comma") {
		cursor.next();
		fields.push(parseFieldSelection(cursor));
	}
	const last = fields[fields.length - 1];
	const end = last ? last.span.end : kw.span.end;
	return {
		type: "pick",
		fields,
		...(unique === true ? { unique: true as const } : {}),
		...(distinctOnKeys !== undefined ? { distinctOnKeys } : {}),
		span: { start: kw.span.start, end }
	};
}

function parseFieldSelection(cursor: TokenCursor): FieldSelection {
	// `pick` accepte deux formes :
	//  - un chemin de champ simple : `name`, `u.email`  (compat historique)
	//  - une expression calculée : `price * qty`, `upper(name)`  (T1 arith, T2 call)
	// On parse toujours une expression puis on décide : si c'est juste un `field`
	// (chemin), on garde la forme historique ; sinon on exige un alias.
	const expr = parseExpression(cursor);
	let endSpan = expr.span;
	let alias: string | undefined;
	if (peekKeyword(cursor, "as")) {
		cursor.next();
		const aliasTok = cursor.expect("ident", "un alias après 'as'");
		alias = aliasTok.value;
		endSpan = aliasTok.span;
	}
	const full = { start: expr.span.start, end: endSpan.end };
	if (expr.type === "field") {
		return alias !== undefined
			? { path: expr.path, alias, span: full }
			: { path: expr.path, span: full };
	}
	if (alias === undefined) {
		throw new SnqlError(
			"Une expression dans `pick` exige un alias : `<expr> as <nom>`",
			"parse_pick_expr_alias",
			full
		);
	}
	return { path: [], expr, alias, span: full };
}

export function parseSort(cursor: TokenCursor): Stage {
	const kw = cursor.next();
	const keys: SortKey[] = [parseSortKey(cursor)];
	while (cursor.peek().kind === "comma") {
		cursor.next();
		keys.push(parseSortKey(cursor));
	}
	const last = keys[keys.length - 1];
	const end = last ? last.span.end : kw.span.end;
	return { type: "sort", keys, span: { start: kw.span.start, end } };
}

function parseSortKey(cursor: TokenCursor): SortKey {
	const { path, span } = parseFieldPath(cursor);
	let direction: "asc" | "desc" = "asc";
	let endSpan = span;
	if (peekKeyword(cursor, "asc") || peekKeyword(cursor, "desc")) {
		const dirTok = cursor.next();
		direction = dirTok.value === "desc" ? "desc" : "asc";
		endSpan = dirTok.span;
	}
	return { path, direction, span: { start: span.start, end: endSpan.end } };
}

export function parseLimit(cursor: TokenCursor): Stage {
	const kw = cursor.next();
	const countTok = cursor.expect("number", "un nombre pour 'limit'");
	const count = Number(countTok.value);
	if (!Number.isInteger(count) || count < 0) {
		throw new SnqlError(
			"'limit' attend un entier positif",
			"parse_limit_invalid",
			countTok.span
		);
	}

	let endSpan = countTok.span;
	let offset: number | undefined;
	if (cursor.peek().kind === "keyword" && cursor.peek().value === "offset") {
		cursor.next();
		const offsetTok = cursor.expect("number", "un nombre pour 'offset'");
		const parsed = Number(offsetTok.value);
		if (!Number.isInteger(parsed) || parsed < 0) {
			throw new SnqlError(
				"'offset' attend un entier positif",
				"parse_offset_invalid",
				offsetTok.span
			);
		}
		offset = parsed;
		endSpan = offsetTok.span;
	}

	const span = { start: kw.span.start, end: endSpan.end };
	return offset !== undefined
		? { type: "limit", count, offset, span }
		: { type: "limit", count, span };
}

/**
 * hook parser sub-query. Consomme le verb + délègue à
 * parseSelect. Refuse mutation (add/update/remove) — sub-queries en
 * position d'expression sont read-only par nature.
 */
setSubqueryParser((cursor: TokenCursor): Query => {
	const verbTok = cursor.peek();
	if (verbTok.kind !== "verb") {
		throw new SnqlError(
			"Sub-query attendue : commence par un verb de lecture (find/get)",
			"parse_subquery_expected_verb",
			verbTok.span
		);
	}
	const op = verbOperation(verbTok.value);
	if (op !== "select") {
		throw new SnqlError(
			`Sub-query doit être une lecture (find/get), pas '${verbTok.value}' (${op})`,
			"parse_subquery_not_select",
			verbTok.span
		);
	}
	cursor.next();
	return parseSelect(cursor, verbTok);
});
