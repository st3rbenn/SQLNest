import { SnqlError } from "../diagnostics";
import { verbOperation } from "../lexer/dictionary";
import type { Token } from "../lexer/token";
import type {
	Assignment,
	DeleteStatement,
	Expr,
	FieldSelection,
	InsertField,
	InsertRow,
	InsertStatement,
	Query,
	SortKey,
	Source,
	Stage,
	Statement,
	UpdateStatement
} from "./ast";
import { TokenCursor } from "./cursor";
import { parseExpression, parseFieldPath } from "./expression";

/** Mots-clés de stage d'un select, dans l'ordre canonique imposé. */
const SELECT_STAGE_ORDER = ["with", "where", "sort", "pick", "limit"] as const;
const SELECT_STAGE_KEYWORDS: ReadonlySet<string> = new Set(SELECT_STAGE_ORDER);
const UPDATE_STAGE_KEYWORDS: ReadonlySet<string> = new Set(["where", "set"]);
const DELETE_STAGE_KEYWORDS: ReadonlySet<string> = new Set(["where"]);

function peekKeyword(cursor: TokenCursor, value: string): boolean {
	const tok = cursor.peek();
	return tok.kind === "keyword" && tok.value === value;
}

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
			return parseInsert(cursor, verbTok);
	}
}

function parseInsert(cursor: TokenCursor, verbTok: Token): InsertStatement {
	const rows: InsertRow[] = [];
	const opener = cursor.peek();
	if (opener.kind === "lbracket") {
		cursor.next();
		rows.push(parseDocument(cursor));
		while (cursor.peek().kind === "comma") {
			cursor.next();
			rows.push(parseDocument(cursor));
		}
		cursor.expect("rbracket", "']' pour fermer la liste de documents");
	} else if (opener.kind === "lbrace") {
		rows.push(parseDocument(cursor));
	} else {
		throw new SnqlError(
			"'add' attend un document { … } ou une liste [ { … }, … ]",
			"parse_insert_expected_doc",
			opener.span
		);
	}

	const into = cursor.peek();
	if (!(into.kind === "keyword" && into.value === "into")) {
		throw new SnqlError(
			"'add' attend 'into <collection>'",
			"parse_insert_missing_into",
			into.span
		);
	}
	cursor.next();
	const nameTok = cursor.expect("ident", "un nom de collection après 'into'");

	return {
		operation: "insert",
		verb: verbTok.value,
		collection: nameTok.value,
		rows,
		span: { start: verbTok.span.start, end: nameTok.span.end }
	};
}

function parseDocument(cursor: TokenCursor): InsertRow {
	const open = cursor.expect("lbrace", "'{' pour ouvrir un document");
	const fields: InsertField[] = [];
	if (cursor.peek().kind !== "rbrace") {
		fields.push(parseInsertField(cursor));
		while (cursor.peek().kind === "comma") {
			cursor.next();
			fields.push(parseInsertField(cursor));
		}
	}
	const close = cursor.expect("rbrace", "'}' pour fermer le document");
	const span = { start: open.span.start, end: close.span.end };
	if (fields.length === 0) {
		throw new SnqlError(
			"Document vide : 'add' attend au moins un champ",
			"parse_insert_empty_doc",
			span
		);
	}
	return { fields, span };
}

function parseInsertField(cursor: TokenCursor): InsertField {
	const key = cursor.peek();
	if (key.kind !== "ident" && key.kind !== "string") {
		throw new SnqlError(
			"Clé de document attendue (identifiant ou chaîne)",
			"parse_insert_key",
			key.span
		);
	}
	cursor.next();
	const colon = cursor.peek();
	if (colon.kind !== "colon") {
		throw new SnqlError(
			"':' attendu après la clé du document",
			"parse_insert_colon",
			colon.span
		);
	}
	cursor.next();
	const value = parseExpression(cursor);
	return {
		column: key.value,
		value,
		span: { start: key.span.start, end: value.span.end }
	};
}

function parseSelect(cursor: TokenCursor, verbTok: Token): Query {
	const source = parseSource(cursor);
	const stages: Stage[] = [];

	if (peekKeyword(cursor, "with")) {
		stages.push(...parseWiths(cursor));
	}
	if (peekKeyword(cursor, "where")) {
		stages.push(parseWhere(cursor));
	}
	if (peekKeyword(cursor, "sort")) {
		stages.push(parseSort(cursor));
	}
	if (peekKeyword(cursor, "pick")) {
		stages.push(parsePick(cursor));
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
function rejectTrailingStage(
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

function parseUpdate(cursor: TokenCursor, verbTok: Token): UpdateStatement {
	const nameTok = cursor.expect("ident", "un nom de collection après 'update'");
	let predicate: Expr | undefined;
	let end = nameTok.span.end;

	if (peekKeyword(cursor, "where")) {
		cursor.next();
		predicate = parseExpression(cursor);
		end = predicate.span.end;
	}

	if (!peekKeyword(cursor, "set")) {
		throw new SnqlError(
			"'update' exige 'set <colonne> = <valeur>'",
			"parse_update_no_set",
			cursor.peek().span
		);
	}
	cursor.next();
	const assignments = parseAssignments(cursor);
	const lastAssign = assignments[assignments.length - 1];
	if (lastAssign !== undefined) {
		end = lastAssign.span.end;
	}

	rejectTrailingStage(cursor, UPDATE_STAGE_KEYWORDS, ["where", "set"]);

	// `where` optionnel : sans lui, l'update porte sur toutes les lignes (assumé).
	const span = { start: verbTok.span.start, end };
	return predicate !== undefined
		? {
				operation: "update",
				verb: verbTok.value,
				collection: nameTok.value,
				predicate,
				assignments,
				span
			}
		: {
				operation: "update",
				verb: verbTok.value,
				collection: nameTok.value,
				assignments,
				span
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

	let predicate: Expr | undefined;
	let end = nameTok.span.end;
	if (peekKeyword(cursor, "where")) {
		cursor.next();
		predicate = parseExpression(cursor);
		end = predicate.span.end;
	}

	rejectTrailingStage(cursor, DELETE_STAGE_KEYWORDS, ["where"]);

	// `where` optionnel : sans lui, le remove porte sur toutes les lignes (assumé).
	const span = { start: verbTok.span.start, end };
	return predicate !== undefined
		? {
				operation: "delete",
				verb: verbTok.value,
				collection: nameTok.value,
				predicate,
				span
			}
		: {
				operation: "delete",
				verb: verbTok.value,
				collection: nameTok.value,
				span
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
function parseWiths(cursor: TokenCursor): Stage[] {
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
