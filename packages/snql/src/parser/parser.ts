import { SnqlError } from "../diagnostics";
import { verbOperation } from "../lexer/dictionary";
import type { Token } from "../lexer/token";
import type { FieldSelection, Query, SortKey, Source, Stage } from "./ast";
import { TokenCursor } from "./cursor";
import { parseExpression, parseFieldPath } from "./expression";

/** Parse un flux de tokens en un AST [[Query]]. */
export function parse(tokens: readonly Token[]): Query {
	const cursor = new TokenCursor(tokens);
	const query = parseQuery(cursor);
	cursor.expect("eof", "la fin de la requête");
	return query;
}

function parseQuery(cursor: TokenCursor): Query {
	const verbTok = cursor.peek();
	if (verbTok.kind !== "verb") {
		throw new SnqlError(
			`Une requête doit commencer par un verbe (get, find, add, update, remove…), trouvé '${verbTok.value}'`,
			"parse_expected_verb",
			verbTok.span
		);
	}
	cursor.next();

	const operation = verbOperation(verbTok.value);
	if (operation === undefined) {
		throw new SnqlError(
			`Verbe inconnu '${verbTok.value}'`,
			"parse_unknown_verb",
			verbTok.span
		);
	}
	if (operation !== "select") {
		throw new SnqlError(
			`Slice 1 ne supporte que la lecture (get / find / show / fetch). '${verbTok.value}' arrivera dans une slice ultérieure.`,
			"parse_unsupported_operation",
			verbTok.span
		);
	}

	const source = parseSource(cursor);

	const stages: Stage[] = [];
	while (cursor.peek().kind === "pipe") {
		cursor.next();
		stages.push(parseStage(cursor));
	}

	const lastStage = stages[stages.length - 1];
	const endSpan = lastStage ? lastStage.span : source.span;
	return {
		operation,
		verb: verbTok.value,
		source,
		stages,
		span: { start: verbTok.span.start, end: endSpan.end }
	};
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

function parseStage(cursor: TokenCursor): Stage {
	const tok = cursor.peek();
	if (tok.kind !== "keyword") {
		throw new SnqlError(
			`Étape de pipeline attendue après '|' (where, pick, sort, limit), trouvé '${tok.value}'`,
			"parse_expected_stage",
			tok.span
		);
	}
	switch (tok.value) {
		case "where":
			return parseWhere(cursor);
		case "pick":
			return parsePick(cursor);
		case "sort":
			return parseSort(cursor);
		case "limit":
			return parseLimit(cursor);
		default:
			throw new SnqlError(
				`Étape '${tok.value}' non supportée en Slice 1 (attendu where, pick, sort, limit)`,
				"parse_unsupported_stage",
				tok.span
			);
	}
}

function parseWhere(cursor: TokenCursor): Stage {
	const kw = cursor.next();
	const predicate = parseExpression(cursor);
	return {
		type: "where",
		predicate,
		span: { start: kw.span.start, end: predicate.span.end }
	};
}

function parsePick(cursor: TokenCursor): Stage {
	const kw = cursor.next();
	const fields: FieldSelection[] = [parseFieldSelection(cursor)];
	while (cursor.peek().kind === "comma") {
		cursor.next();
		fields.push(parseFieldSelection(cursor));
	}
	const last = fields[fields.length - 1];
	const end = last ? last.span.end : kw.span.end;
	return { type: "pick", fields, span: { start: kw.span.start, end } };
}

function parseFieldSelection(cursor: TokenCursor): FieldSelection {
	const { path, span } = parseFieldPath(cursor);
	let endSpan = span;
	let alias: string | undefined;
	if (cursor.peek().kind === "keyword" && cursor.peek().value === "as") {
		cursor.next();
		const aliasTok = cursor.expect("ident", "un alias après 'as'");
		alias = aliasTok.value;
		endSpan = aliasTok.span;
	}
	const full = { start: span.start, end: endSpan.end };
	return alias !== undefined
		? { path, alias, span: full }
		: { path, span: full };
}

function parseSort(cursor: TokenCursor): Stage {
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
	let direction: "asc" | "desc" = "asc";
	let signStart: number | null = null;
	if (cursor.peek().kind === "minus") {
		direction = "desc";
		signStart = cursor.next().span.start.offset;
	} else if (cursor.peek().kind === "plus") {
		direction = "asc";
		signStart = cursor.next().span.start.offset;
	}

	const { path, span } = parseFieldPath(cursor);
	let endSpan = span;

	if (
		cursor.peek().kind === "keyword" &&
		(cursor.peek().value === "asc" || cursor.peek().value === "desc")
	) {
		if (signStart !== null) {
			throw new SnqlError(
				"Direction de tri redondante (signe +/- et mot-clé asc/desc)",
				"parse_sort_redundant",
				cursor.peek().span
			);
		}
		const dirTok = cursor.next();
		direction = dirTok.value === "desc" ? "desc" : "asc";
		endSpan = dirTok.span;
	}

	const start =
		signStart !== null ? { ...span.start, offset: signStart } : span.start;
	return { path, direction, span: { start, end: endSpan.end } };
}

function parseLimit(cursor: TokenCursor): Stage {
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
