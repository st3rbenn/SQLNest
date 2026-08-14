import { SnqlError } from "../diagnostics";
import { verbOperation } from "../lexer/dictionary";
import type { Token } from "../lexer/token";
import type {
	Assignment,
	DeleteStatement,
	Expr,
	FieldSelection,
	GroupKey,
	InsertField,
	InsertRow,
	InsertStatement,
	OnConflictAction,
	OnConflictClause,
	Query,
	SortKey,
	Source,
	Stage,
	Statement,
	UpdateStatement
} from "./ast";
import { TokenCursor } from "./cursor";
import {
	parseExpression,
	parseFieldPath,
	parseKeyValueEntry,
	setSubqueryParser
} from "./expression";

/** Mots-clés de stage d'un select, dans l'ordre canonique imposé. */
const SELECT_STAGE_ORDER = ["with", "where", "group", "having", "pick", "sort", "limit"] as const;
const SELECT_STAGE_KEYWORDS: ReadonlySet<string> = new Set(SELECT_STAGE_ORDER);
const UPDATE_STAGE_KEYWORDS: ReadonlySet<string> = new Set(["with", "where", "set"]);
const DELETE_STAGE_KEYWORDS: ReadonlySet<string> = new Set(["where"]);

function peekKeyword(cursor: TokenCursor, value: string, ahead = 0): boolean {
	const tok = cursor.peek(ahead);
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
	let sourceQuery: Query | undefined;
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
	} else if (opener.kind === "lparen") {
		// Sprint T2/14 : INSERT SELECT — `add (find … pick a, b) into t`. Le
		// mapping cols est inféré du pick au lower (`pick x as tgt` → tgt).
		sourceQuery = parseInsertSourceQuery(cursor);
	} else {
		throw new SnqlError(
			"'add' attend un document { … }, une liste [ { … }, … ] ou une sub-query ( find … pick … )",
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

	let end = nameTok.span.end;
	// Sprint T2/13 : `on conflict (k1, k2) [ignore | edit set ... [where ...]]`.
	let onConflict: OnConflictClause | undefined;
	if (peekKeyword(cursor, "on") && peekKeyword(cursor, "conflict", 1)) {
		// Sprint T2/14 : refus `on conflict` combiné avec INSERT SELECT v1 —
		// sémantique plus complexe (DO UPDATE référence EXCLUDED depuis un
		// SELECT, PG supporte mais mapping non-trivial). Bloqué au lower.
		onConflict = parseOnConflict(cursor);
		end = onConflict.span.end;
	}
	// Sprint T2/13 : `pick count` — retourne seulement rowCount, pas les rows.
	const returnRowCount = tryConsumePickCount(cursor);
	if (returnRowCount !== undefined) end = returnRowCount.end;

	const span = { start: verbTok.span.start, end };
	return {
		operation: "insert",
		verb: verbTok.value,
		collection: nameTok.value,
		rows,
		...(sourceQuery !== undefined ? { sourceQuery } : {}),
		...(onConflict !== undefined ? { onConflict } : {}),
		...(returnRowCount !== undefined ? { returnRowCount: true as const } : {}),
		span
	};
}

/**
 * Sprint T2/14 : parse `(find … pick a, b)` en position source d'un `add`.
 * Réutilise le hook subquery de T2/11 (setSubqueryParser). La validation
 * `pick` présent + exactement 1..N fields est faite au lower.
 */
function parseInsertSourceQuery(cursor: TokenCursor): Query {
	cursor.expect("lparen", "'(' pour ouvrir la sub-query source d'un INSERT SELECT");
	const verbTok = cursor.peek();
	if (verbTok.kind !== "verb") {
		throw new SnqlError(
			"'add (…) into t' — la sub-query source doit commencer par un verbe de lecture (find/get)",
			"parse_insert_source_expected_verb",
			verbTok.span
		);
	}
	const op = verbOperation(verbTok.value);
	if (op !== "select") {
		throw new SnqlError(
			`'add (…) into t' — la sub-query source doit être une lecture (find/get), pas '${verbTok.value}'`,
			"parse_insert_source_not_select",
			verbTok.span
		);
	}
	cursor.next();
	const query = parseSelect(cursor, verbTok);
	cursor.expect("rparen", "')' pour fermer la sub-query source");
	return query;
}

/**
 * Sprint T2/13 : lit `on conflict (k1, k2) [ignore | edit set c = expr, ... [where pred]]`.
 * `edit` est le verbe alias pour `update` — ici c'est un mot contextuel après
 * `on conflict (…)` (soft-keyword post-parens, pas de conflit avec le verb en
 * début de statement puisqu'on est déjà dans un `add`).
 */
function parseOnConflict(cursor: TokenCursor): OnConflictClause {
	const onTok = cursor.next(); // 'on'
	cursor.next(); // 'conflict'
	cursor.expect("lparen", "'(' après 'on conflict' — les keys sont entre parens");
	const keys: string[] = [cursor.expect("ident", "un nom de colonne").value];
	while (cursor.peek().kind === "comma") {
		cursor.next();
		keys.push(cursor.expect("ident", "un nom de colonne").value);
	}
	const rparen = cursor.expect("rparen", "')' pour fermer 'on conflict (...)'");
	let action: OnConflictAction;
	let endOffset = rparen.span.end;

	const next = cursor.peek();
	if (next.kind === "keyword" && next.value === "ignore") {
		const ignTok = cursor.next();
		action = { kind: "ignore", span: ignTok.span };
		endOffset = ignTok.span.end;
	} else {
		// Attendu : `edit set ...` — le verb `edit` (alias update) sert de
		// mot-clé contextuel après `on conflict (…)`. Erreur claire sinon.
		const editTok = cursor.peek();
		if (!(editTok.kind === "verb" && editTok.value === "edit")) {
			throw new SnqlError(
				"'on conflict (...)' attend 'ignore' ou 'edit set <col> = <expr> [where <pred>]'",
				"parse_on_conflict_action",
				editTok.span
			);
		}
		cursor.next(); // 'edit'
		if (!peekKeyword(cursor, "set")) {
			throw new SnqlError(
				"'edit' dans 'on conflict' attend 'set <col> = <expr>'",
				"parse_on_conflict_edit_set",
				cursor.peek().span
			);
		}
		cursor.next(); // 'set'
		const assignments = parseAssignments(cursor);
		let end = assignments[assignments.length - 1]?.span.end ?? endOffset;
		let where: Expr | undefined;
		if (peekKeyword(cursor, "where")) {
			cursor.next();
			where = parseExpression(cursor);
			end = where.span.end;
		}
		action = {
			kind: "update",
			assignments,
			...(where !== undefined ? { where } : {}),
			span: { start: editTok.span.start, end }
		};
		endOffset = end;
	}
	return {
		keys,
		action,
		span: { start: onTok.span.start, end: endOffset }
	};
}

/**
 * Sprint T2/13 : consomme `pick count` si présent. `count` reste un ident
 * (soft-keyword contextuel après `pick` en position mutation, pas de conflit
 * avec la fonction `count()` qui exige `(` derrière). Renvoie le span consommé
 * ou undefined.
 */
function tryConsumePickCount(cursor: TokenCursor): { end: import("../lexer/token").Position } | undefined {
	if (!peekKeyword(cursor, "pick")) return undefined;
	const p1 = cursor.peek(1);
	if (!(p1.kind === "ident" && p1.value.toLowerCase() === "count")) return undefined;
	const p2 = cursor.peek(2);
	// `count(` = fonction (interdite en mutation de toute façon, mais on ne
	// veut pas capturer ici pour laisser l'erreur remonter proprement).
	if (p2.kind === "lparen") return undefined;
	cursor.next(); // 'pick'
	const countTok = cursor.next(); // 'count' ident
	return { end: countTok.span.end };
}

function parseDocument(cursor: TokenCursor): InsertRow {
	const open = cursor.expect("lbrace", "'{' pour ouvrir un document");
	const fields: InsertField[] = [];
	const seenKeys = new Set<string>();
	if (cursor.peek().kind !== "rbrace") {
		for (;;) {
			// Réutilise le helper commun avec object literal — même shape parser
			// (key:value + keywords en bare key + span propagé). On mappe ObjectEntry
			// → InsertField {column, value, span} pour préserver le contrat legacy.
			const entry = parseKeyValueEntry(cursor, 0);
			if (seenKeys.has(entry.key)) {
				throw new SnqlError(
					`Clé dupliquée '${entry.key}' dans le document`,
					"parse_object_literal_duplicate_key",
					entry.keySpan
				);
			}
			seenKeys.add(entry.key);
			fields.push({
				column: entry.key,
				value: entry.value,
				span: entry.span
			});
			const next = cursor.peek();
			if (next.kind === "comma") {
				cursor.next();
				continue;
			}
			if (next.kind === "rbrace") break;
			throw new SnqlError(
				"',' ou '}' attendu",
				"parse_object_literal_close_expected",
				next.span
			);
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

function parseSelect(cursor: TokenCursor, verbTok: Token): Query {
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
	let end = nameTok.span.end;

	// Sprint T2/14 : `update t as a` — alias source optionnel pour référencer
	// les cols via `a.col` en cohabitation avec les alias joins.
	let alias: string | undefined;
	if (peekKeyword(cursor, "as")) {
		cursor.next();
		const aliasTok = cursor.expect("ident", "un alias après 'as'");
		alias = aliasTok.value;
		end = aliasTok.span.end;
	}

	// Sprint T2/14 : `with one X on l=f [and ...]` — joins optionnels avant
	// where/set. Réutilise parseWiths qui gère la chaîne `and`.
	let joins: Stage[] | undefined;
	if (peekKeyword(cursor, "with")) {
		joins = parseWiths(cursor);
		const lastJoin = joins[joins.length - 1];
		if (lastJoin !== undefined) end = lastJoin.span.end;
	}

	let predicate: Expr | undefined;
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

	// Sprint T2/13 : `pick count` — dropRETURNING côté PG, ne renvoie que
	// rowCount. Consommé avant le trailing-stage guard (`pick` n'est pas dans
	// UPDATE_STAGE_KEYWORDS, il aurait fini `parse_unexpected`).
	const rrc = tryConsumePickCount(cursor);
	if (rrc !== undefined) end = rrc.end;

	rejectTrailingStage(cursor, UPDATE_STAGE_KEYWORDS, ["with", "where", "set"]);

	// `where` optionnel : sans lui, l'update porte sur toutes les lignes (assumé).
	const span = { start: verbTok.span.start, end };
	const returnRowCount = rrc !== undefined ? { returnRowCount: true as const } : {};
	const optional = {
		...(alias !== undefined ? { alias } : {}),
		...(joins !== undefined && joins.length > 0 ? { joins } : {}),
		...returnRowCount
	};
	return predicate !== undefined
		? {
				operation: "update",
				verb: verbTok.value,
				collection: nameTok.value,
				predicate,
				assignments,
				...optional,
				span
			}
		: {
				operation: "update",
				verb: verbTok.value,
				collection: nameTok.value,
				assignments,
				...optional,
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

	// Sprint T2/13 : `pick count` — dropRETURNING côté PG.
	const rrc = tryConsumePickCount(cursor);
	if (rrc !== undefined) end = rrc.end;

	rejectTrailingStage(cursor, DELETE_STAGE_KEYWORDS, ["where"]);

	// `where` optionnel : sans lui, le remove porte sur toutes les lignes (assumé).
	const span = { start: verbTok.span.start, end };
	const returnRowCount = rrc !== undefined ? { returnRowCount: true as const } : {};
	return predicate !== undefined
		? {
				operation: "delete",
				verb: verbTok.value,
				collection: nameTok.value,
				predicate,
				...returnRowCount,
				span
			}
		: {
				operation: "delete",
				verb: verbTok.value,
				collection: nameTok.value,
				...returnRowCount,
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

function parsePick(cursor: TokenCursor): Stage {
	const kw = cursor.next();
	// Sprint T2/10 : détecte `unique` (ident soft-keyword) + optional `on (keys)`.
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
				cursor.expect("lparen", "'(' après 'unique on' — les keys DISTINCT ON sont entre parens");
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

/**
 * Sprint T2/11 : hook parser sub-query. Consomme le verb + délègue à
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
