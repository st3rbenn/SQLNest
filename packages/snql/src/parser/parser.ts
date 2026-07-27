import { SnqlError } from "../diagnostics";
import { verbOperation } from "../lexer/dictionary";
import type { Token } from "../lexer/token";
import type {
	Assignment,
	DeleteStatement,
	Expr,
	FieldSelection,
	Query,
	SortKey,
	Source,
	Stage,
	Statement,
	UpdateStatement
} from "./ast";
import { TokenCursor } from "./cursor";
import { parseExpression, parseFieldPath } from "./expression";

/** Parse un flux de tokens en un AST [[Statement]] (lecture ou mutation). */
export function parse(tokens: readonly Token[]): Statement {
	const cursor = new TokenCursor(tokens);
	const statement = parseStatement(cursor);
	cursor.expect("eof", "la fin de la requête");
	return statement;
}

function parseStatement(cursor: TokenCursor): Statement {
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
	switch (operation) {
		case "select":
			return parseSelect(cursor, verbTok);
		case "update":
			return parseUpdate(cursor, verbTok);
		case "delete":
			return parseDelete(cursor, verbTok);
		case "insert":
			throw new SnqlError(
				"L'insertion (add / create) arrive dans la slice suivante (4b).",
				"parse_unsupported_operation",
				verbTok.span
			);
	}
}

function parseSelect(cursor: TokenCursor, verbTok: Token): Query {
	const source = parseSource(cursor);

	const stages: Stage[] = [];
	while (cursor.peek().kind === "pipe") {
		cursor.next();
		stages.push(parseStage(cursor));
	}

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

function parseUpdate(cursor: TokenCursor, verbTok: Token): UpdateStatement {
	const nameTok = cursor.expect("ident", "un nom de collection après 'update'");
	const predicates: Expr[] = [];
	const assignments: Assignment[] = [];
	let end = nameTok.span.end;

	while (cursor.peek().kind === "pipe") {
		cursor.next();
		const kw = cursor.peek();
		if (kw.kind === "keyword" && kw.value === "where") {
			cursor.next();
			const predicate = parseExpression(cursor);
			predicates.push(predicate);
			end = predicate.span.end;
		} else if (kw.kind === "keyword" && kw.value === "set") {
			cursor.next();
			const parsed = parseAssignments(cursor);
			assignments.push(...parsed);
			const last = parsed[parsed.length - 1];
			if (last !== undefined) {
				end = last.span.end;
			}
		} else {
			throw new SnqlError(
				`Étape '${kw.value}' invalide dans un 'update' (attendu where, set)`,
				"parse_unsupported_stage",
				kw.span
			);
		}
	}

	if (assignments.length === 0) {
		throw new SnqlError(
			"'update' exige au moins un 'set <colonne> = <valeur>'",
			"parse_update_no_set",
			verbTok.span
		);
	}
	if (predicates.length === 0) {
		throw new SnqlError(
			"'update' exige un 'where' — un write non filtré est refusé. Ajoutez une condition.",
			"parse_mutation_no_filter",
			verbTok.span
		);
	}

	return {
		operation: "update",
		verb: verbTok.value,
		collection: nameTok.value,
		predicate: andAll(predicates),
		assignments,
		span: { start: verbTok.span.start, end }
	};
}

function parseDelete(cursor: TokenCursor, verbTok: Token): DeleteStatement {
	const fromTok = cursor.peek();
	if (!(fromTok.kind === "keyword" && fromTok.value === "from")) {
		throw new SnqlError(
			"'remove' attend 'from <collection>'",
			"parse_delete_missing_from",
			fromTok.span
		);
	}
	cursor.next();
	const nameTok = cursor.expect("ident", "un nom de collection après 'from'");

	const predicates: Expr[] = [];
	let end = nameTok.span.end;
	while (cursor.peek().kind === "pipe") {
		cursor.next();
		const kw = cursor.peek();
		if (kw.kind === "keyword" && kw.value === "where") {
			cursor.next();
			const predicate = parseExpression(cursor);
			predicates.push(predicate);
			end = predicate.span.end;
		} else {
			throw new SnqlError(
				`Étape '${kw.value}' invalide dans un 'remove' (attendu where)`,
				"parse_unsupported_stage",
				kw.span
			);
		}
	}

	if (predicates.length === 0) {
		throw new SnqlError(
			"'remove' exige un 'where' — un delete non filtré est refusé. Ajoutez une condition.",
			"parse_mutation_no_filter",
			verbTok.span
		);
	}

	return {
		operation: "delete",
		verb: verbTok.value,
		collection: nameTok.value,
		predicate: andAll(predicates),
		span: { start: verbTok.span.start, end }
	};
}

function parseAssignments(cursor: TokenCursor): Assignment[] {
	const assignments: Assignment[] = [parseAssignment(cursor)];
	while (cursor.peek().kind === "comma") {
		cursor.next();
		assignments.push(parseAssignment(cursor));
	}
	return assignments;
}

function parseAssignment(cursor: TokenCursor): Assignment {
	const col = cursor.expect("ident", "un nom de colonne");
	const eq = cursor.peek();
	if (!(eq.kind === "op" && eq.value === "=")) {
		throw new SnqlError(
			"Affectation attendue : <colonne> = <valeur>",
			"parse_assignment",
			eq.span
		);
	}
	cursor.next();
	const value = parseExpression(cursor);
	return {
		column: col.value,
		value,
		span: { start: col.span.start, end: value.span.end }
	};
}

/** Combine plusieurs prédicats en une conjonction `and`. */
function andAll(predicates: readonly Expr[]): Expr {
	let combined = predicates[0];
	if (combined === undefined) {
		throw new SnqlError("Prédicat manquant", "parse_missing_predicate");
	}
	for (let i = 1; i < predicates.length; i += 1) {
		const next = predicates[i];
		if (next === undefined) {
			continue;
		}
		combined = {
			type: "logical",
			operator: "and",
			left: combined,
			right: next,
			span: { start: combined.span.start, end: next.span.end }
		};
	}
	return combined;
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
		case "with":
			return parseWith(cursor);
		default:
			throw new SnqlError(
				`Étape '${tok.value}' inconnue (attendu where, with, pick, sort, limit)`,
				"parse_unsupported_stage",
				tok.span
			);
	}
}

function parseWith(cursor: TokenCursor): Stage {
	const kw = cursor.next(); // 'with'
	const collection = cursor.expect(
		"ident",
		"un nom de collection après 'with'"
	);
	let alias: string | undefined;
	if (cursor.peek().kind === "keyword" && cursor.peek().value === "as") {
		cursor.next();
		alias = cursor.expect("ident", "un alias après 'as'").value;
	}
	if (!(cursor.peek().kind === "keyword" && cursor.peek().value === "on")) {
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
	const span = { start: kw.span.start, end: foreign.span.end };
	return alias !== undefined
		? {
				type: "with",
				collection: collection.value,
				alias,
				localField,
				foreignField: foreign.path,
				span
			}
		: {
				type: "with",
				collection: collection.value,
				localField,
				foreignField: foreign.path,
				span
			};
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
