import { SnqlError } from "../diagnostics";
import { verbOperation } from "../lexer/dictionary";
import type { Token } from "../lexer/token";
import type {
	Assignment,
	DeleteStatement,
	Expr,
	InsertField,
	InsertRow,
	InsertStatement,
	OnConflictAction,
	OnConflictClause,
	Query,
	Stage,
	UpdateStatement
} from "./ast";
import type { TokenCursor } from "./cursor";
import { parseExpression, parseKeyValueEntry } from "./expression";
import { peekKeyword } from "./parser-peek";
import { parseSelect, parseWiths, rejectTrailingStage } from "./parser-select";

/**
 * Écritures : `add`, `update`, `remove`, documents, affectations, upsert.
 */

const UPDATE_STAGE_KEYWORDS: ReadonlySet<string> = new Set([
	"with",
	"where",
	"set"
]);

const DELETE_STAGE_KEYWORDS: ReadonlySet<string> = new Set(["where"]);

export function parseInsert(
	cursor: TokenCursor,
	verbTok: Token
): InsertStatement {
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
		// INSERT SELECT — `add (find … pick a, b) into t`. Le
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
	// `on conflict (k1, k2) [ignore | edit set... [where...]]`.
	let onConflict: OnConflictClause | undefined;
	if (peekKeyword(cursor, "on") && peekKeyword(cursor, "conflict", 1)) {
		// refus `on conflict` combiné avec INSERT SELECT v1
		// sémantique plus complexe (DO UPDATE référence EXCLUDED depuis un
		// SELECT, PG supporte mais mapping non-trivial). Bloqué au lower.
		onConflict = parseOnConflict(cursor);
		end = onConflict.span.end;
	}
	// `pick count` — retourne seulement rowCount, pas les rows.
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
 * parse `(find … pick a, b)` en position source d'un `add`.
 * Réutilise le hook subquery de (setSubqueryParser). La validation
 * `pick` présent + exactement 1..N fields est faite au lower.
 */
function parseInsertSourceQuery(cursor: TokenCursor): Query {
	cursor.expect(
		"lparen",
		"'(' pour ouvrir la sub-query source d'un INSERT SELECT"
	);
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
 * lit `on conflict (k1, k2) [ignore | edit set c = expr, ... [where pred]]`.
 * `edit` est le verbe alias pour `update` — ici c'est un mot contextuel après
 * `on conflict (…)` (soft-keyword post-parens, pas de conflit avec le verb en
 * début de statement puisqu'on est déjà dans un `add`).
 */
function parseOnConflict(cursor: TokenCursor): OnConflictClause {
	const onTok = cursor.next(); // 'on'
	cursor.next(); // 'conflict'
	cursor.expect(
		"lparen",
		"'(' après 'on conflict' — les keys sont entre parens"
	);
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
 * consomme `pick count` si présent. `count` reste un ident
 * (soft-keyword contextuel après `pick` en position mutation, pas de conflit
 * avec la fonction `count()` qui exige `(` derrière). Renvoie le span consommé
 * ou undefined.
 */
function tryConsumePickCount(
	cursor: TokenCursor
): { end: import("../lexer/token").Position } | undefined {
	if (!peekKeyword(cursor, "pick")) return undefined;
	const p1 = cursor.peek(1);
	if (!(p1.kind === "ident" && p1.value.toLowerCase() === "count"))
		return undefined;
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

export function parseUpdate(
	cursor: TokenCursor,
	verbTok: Token
): UpdateStatement {
	const nameTok = cursor.expect("ident", "un nom de collection après 'update'");
	let end = nameTok.span.end;

	// `update t as a` — alias source optionnel pour référencer
	// les cols via `a.col` en cohabitation avec les alias joins.
	let alias: string | undefined;
	if (peekKeyword(cursor, "as")) {
		cursor.next();
		const aliasTok = cursor.expect("ident", "un alias après 'as'");
		alias = aliasTok.value;
		end = aliasTok.span.end;
	}

	// `with one X on l=f [and...]` — joins optionnels avant
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

	// `pick count` — dropRETURNING côté PG, ne renvoie que
	// rowCount. Consommé avant le trailing-stage guard (`pick` n'est pas dans
	// UPDATE_STAGE_KEYWORDS, il aurait fini `parse_unexpected`).
	const rrc = tryConsumePickCount(cursor);
	if (rrc !== undefined) end = rrc.end;

	rejectTrailingStage(cursor, UPDATE_STAGE_KEYWORDS, ["with", "where", "set"]);

	// `where` optionnel : sans lui, l'update porte sur toutes les lignes (assumé).
	const span = { start: verbTok.span.start, end };
	const returnRowCount =
		rrc !== undefined ? { returnRowCount: true as const } : {};
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

export function parseDelete(
	cursor: TokenCursor,
	verbTok: Token
): DeleteStatement {
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

	// `pick count` — dropRETURNING côté PG.
	const rrc = tryConsumePickCount(cursor);
	if (rrc !== undefined) end = rrc.end;

	rejectTrailingStage(cursor, DELETE_STAGE_KEYWORDS, ["where"]);

	// `where` optionnel : sans lui, le remove porte sur toutes les lignes (assumé).
	const span = { start: verbTok.span.start, end };
	const returnRowCount =
		rrc !== undefined ? { returnRowCount: true as const } : {};
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
