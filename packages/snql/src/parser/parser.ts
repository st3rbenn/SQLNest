import { SnqlError } from "../diagnostics";
import { verbOperation } from "../lexer/dictionary";
import type { Span, Token } from "../lexer/token";
import type { SnqlType } from "../schema/model";
import type {
	AddColumnStmt,
	AddEnumMemberStmt,
	AddIndexStmt,
	Assignment,
	CreateEnumStmt,
	CreateTableStmt,
	DDLFieldDef,
	DDLFieldTypeRef,
	DeleteStatement,
	DropColumnStmt,
	DropEnumStmt,
	DropIndexStmt,
	DropTableStmt,
	Expr,
	FieldSelection,
	GroupKey,
	InsertField,
	InsertRow,
	InsertStatement,
	IntrospectStatement,
	IsolationLevel,
	LetBinding,
	LetStatement,
	OnConflictAction,
	OnConflictClause,
	Query,
	RawStatement,
	SavepointStatement,
	SortKey,
	Source,
	Stage,
	Statement,
	TransactionBodyItem,
	TransactionStatement,
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
const UPDATE_STAGE_KEYWORDS: ReadonlySet<string> = new Set([
	"with",
	"where",
	"set"
]);
const DELETE_STAGE_KEYWORDS: ReadonlySet<string> = new Set(["where"]);

function peekKeyword(cursor: TokenCursor, value: string, ahead = 0): boolean {
	const tok = cursor.peek(ahead);
	return tok.kind === "keyword" && tok.value === value;
}

/**
 * Peek soft-ident (kind === "ident" + value comparé case-insensitive) —
 * miroir peekKeyword pour les mots comme `column`, `unique`, `nullable`
 * qui restent idents pour ne pas casser un usage nom-de-champ ailleurs.
 */
function peekIdent(cursor: TokenCursor, value: string, ahead = 0): boolean {
	const tok = cursor.peek(ahead);
	return tok.kind === "ident" && tok.value.toLowerCase() === value;
}

/** Parse un flux de tokens en un AST [[Statement]] (lecture ou mutation). */
export function parse(tokens: readonly Token[]): Statement {
	const cursor = new TokenCursor(tokens);
	const statement = parseStatement(cursor);
	checkNoDanglingUnionAll(cursor);
	cursor.expect("eof", "la fin de la requête");
	return statement;
}

function parseStatement(cursor: TokenCursor): Statement {
	// `let x = <query>; ... <body>` — CTE. Un ou plusieurs
	// bindings en tête suivis du statement principal. `let` est soft-keyword
	// (utilisable comme ident ailleurs — ex. col nommée `let`).
	const first = cursor.peek();
	if (first.kind === "ident" && first.value.toLowerCase() === "let") {
		return parseLet(cursor);
	}
	// `transaction [isolation …] { … }` — bloc atomique
	// multi-statements. Détection avant le check verb (transaction est un
	// keyword, pas un verb).
	if (first.kind === "keyword" && first.value === "transaction") {
		return parseTransaction(cursor);
	}
	// `list tables` — statement d'introspection. `list` reste
	// ident soft-keyword (pour ne pas casser `pick x as list` où list est
	// alias) — détecté ici uniquement en tête de statement.
	if (first.kind === "ident" && first.value.toLowerCase() === "list") {
		return parseIntrospectList(cursor);
	}
	// `describe <table>` — même stratégie soft-keyword. Une
	// col nommée `describe` reste utilisable ailleurs (pick/where/set).
	if (first.kind === "ident" && first.value.toLowerCase() === "describe") {
		return parseIntrospectDescribe(cursor);
	}
	// `raw "sql"` (PG) ou `raw {...}` (Mongo) — escape hatch.
	// Soft-keyword pour ne pas casser une col nommée `raw` ailleurs.
	if (first.kind === "ident" && first.value.toLowerCase() === "raw") {
		return parseRaw(cursor);
	}
	// DDL Tier-2 (ADR-029) — dispatch avant le check verb `create` (alias
	// insert). `create table T {...}` = DDL create-table ; `create {...} into T`
	// reste insert alias (`create` ∈ VERB_SYNONYMS → 'insert'). Peek à 1 ahead
	// pour discriminer sans casser la surface DML existante.
	if (
		first.kind === "verb" &&
		first.value.toLowerCase() === "create" &&
		peekKeyword(cursor, "table", 1)
	) {
		return parseCreateTable(cursor);
	}
	// Enum/1 (ADR-030) : `create enum <name> { "m1", "m2" }`. `enum` reste
	// soft-ident (préserve `add {enum: "x"} into t`). Peek 1 ahead pour
	// discriminer avec `create {...} into T` (verb insert alias).
	if (
		first.kind === "verb" &&
		first.value.toLowerCase() === "create" &&
		peekIdent(cursor, "enum", 1)
	) {
		return parseCreateEnum(cursor);
	}
	// DDL/2 : `add column <col> <type> ... into <table>` — dispatch avant le
	// check verb `add` (alias insert). `column` reste soft-ident (une col
	// nommée `column` dans `add {column: "id", ...}` reste valide). Peek à 1
	// ahead pour discriminer avec `add {...} into T` (`add` ∈ VERB_SYNONYMS
	// → 'insert') sans casser la surface DML existante.
	if (
		first.kind === "verb" &&
		first.value.toLowerCase() === "add" &&
		peekIdent(cursor, "column", 1)
	) {
		return parseAddColumn(cursor);
	}
	// Enum/3 : `add enum member <Name> "m" [if not exists]`. Dispatch avant
	// `add column`/`add index` — `enum` + `member` sont soft-idents. Peek 2
	// ahead sur `member` pour discriminer avec `add enum {...}` (aucun sens
	// V1 mais garde-fou surface DML `add {enum: "x"} into t` insert alias).
	if (
		first.kind === "verb" &&
		first.value.toLowerCase() === "add" &&
		peekIdent(cursor, "enum", 1) &&
		peekIdent(cursor, "member", 2)
	) {
		return parseAddEnumMember(cursor);
	}
	// DDL/3 : `add index (fields) into <table>` ou `add unique index (fields) into <table>`.
	// `index` reste soft-ident (une col nommée `index` reste valide). Peek à 1
	// ahead : `add index` direct, OU `add unique index` (peek 2 ahead sur `index`
	// après `unique` à position 1).
	if (
		first.kind === "verb" &&
		first.value.toLowerCase() === "add" &&
		(peekIdent(cursor, "index", 1) ||
			(peekIdent(cursor, "unique", 1) && peekIdent(cursor, "index", 2)))
	) {
		return parseAddIndex(cursor);
	}
	// DDL/3 : `drop index <name> from <table> [if exists]`. `drop` reste
	// soft-ident (comme `list`/`describe`/`raw`) — un ident nommé `drop`
	// dans le DML reste valide. Dispatch au head-of-statement uniquement.
	if (
		first.kind === "ident" &&
		first.value.toLowerCase() === "drop" &&
		peekIdent(cursor, "index", 1)
	) {
		return parseDropIndex(cursor);
	}
	// DDL/4 : `drop table <name> [if exists]`. Destructive — le frontend applique
	// D7 typing UI gate. `table` reste soft-keyword (déjà KEYWORDS pour DDL/1).
	if (
		first.kind === "ident" &&
		first.value.toLowerCase() === "drop" &&
		peekKeyword(cursor, "table", 1)
	) {
		return parseDropTable(cursor);
	}
	// DDL/4 : `drop column <col> from <table> [if exists]`. Destructive — D7 UI.
	// `column` reste soft-ident (préserve `add {column: "id"} into T` insert alias).
	if (
		first.kind === "ident" &&
		first.value.toLowerCase() === "drop" &&
		peekIdent(cursor, "column", 1)
	) {
		return parseDropColumn(cursor);
	}
	// Enum/3 : `drop enum <name> [if exists] [cascade]`. Destructive — D7 UI
	// (typing gate). `enum` reste soft-ident. RESTRICT natif PG par défaut ;
	// CASCADE explicite drop les colonnes utilisatrices.
	if (
		first.kind === "ident" &&
		first.value.toLowerCase() === "drop" &&
		peekIdent(cursor, "enum", 1)
	) {
		return parseDropEnum(cursor);
	}
	const verbTok = first;
	if (verbTok.kind !== "verb") {
		throw new SnqlError(
			`Une requête doit commencer par un verbe (get, find, add, update, remove…) ou 'transaction', trouvé '${verbTok.value}'`,
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

/**
 * `list <sub-command>` — statement d'introspection.
 * Sous-commandes : `tables`, `schemas`, `indexes [on t]`, `databases`
 * (Mongo-first), `schema_events` (SQLNest system).
 */
function parseIntrospectList(cursor: TokenCursor): IntrospectStatement {
	const listTok = cursor.next(); // `list`
	const sub = cursor.peek();
	if (sub.kind !== "ident") {
		throw new SnqlError(
			`'list' attend une sous-commande (tables / schemas / indexes / databases / schema_events), trouvé '${sub.value}'`,
			"parse_introspect_unknown_list",
			sub.span
		);
	}
	const subLower = sub.value.toLowerCase();
	if (subLower === "tables") {
		const subTok = cursor.next();
		const tail = parseIntrospectTail(cursor);
		const endSpan =
			tail.stages.length > 0
				? tail.stages[tail.stages.length - 1]!.span
				: subTok.span;
		return {
			operation: "introspect",
			kind: "list-tables",
			...(tail.stages.length > 0 ? { stages: tail.stages } : {}),
			span: { start: listTok.span.start, end: endSpan.end }
		};
	}
	if (subLower === "schemas") {
		const subTok = cursor.next();
		const tail = parseIntrospectTail(cursor);
		const endSpan =
			tail.stages.length > 0
				? tail.stages[tail.stages.length - 1]!.span
				: subTok.span;
		return {
			operation: "introspect",
			kind: "list-schemas",
			...(tail.stages.length > 0 ? { stages: tail.stages } : {}),
			span: { start: listTok.span.start, end: endSpan.end }
		};
	}
	if (subLower === "indexes") {
		const subTok = cursor.next();
		// `on <table>` optionnel — restreint aux indexes de la table cible.
		let target: string | undefined;
		let targetEnd = subTok.span.end;
		if (peekKeyword(cursor, "on")) {
			cursor.next();
			const targetTok = cursor.peek();
			if (targetTok.kind !== "ident") {
				throw new SnqlError(
					`'list indexes on' attend un nom de table, trouvé '${targetTok.value}'`,
					"parse_introspect_indexes_missing_target",
					targetTok.span
				);
			}
			cursor.next();
			target = targetTok.value;
			targetEnd = targetTok.span.end;
		}
		const tail = parseIntrospectTail(cursor);
		const endSpan =
			tail.stages.length > 0
				? tail.stages[tail.stages.length - 1]!.span
				: { start: targetEnd, end: targetEnd };
		return {
			operation: "introspect",
			kind: "list-indexes",
			...(target !== undefined ? { target } : {}),
			...(tail.stages.length > 0 ? { stages: tail.stages } : {}),
			span: { start: listTok.span.start, end: endSpan.end }
		};
	}
	if (subLower === "databases") {
		const subTok = cursor.next();
		const tail = parseIntrospectTail(cursor);
		const endSpan =
			tail.stages.length > 0
				? tail.stages[tail.stages.length - 1]!.span
				: subTok.span;
		return {
			operation: "introspect",
			kind: "list-databases",
			...(tail.stages.length > 0 ? { stages: tail.stages } : {}),
			span: { start: listTok.span.start, end: endSpan.end }
		};
	}
	if (subLower === "schema_events") {
		const subTok = cursor.next();
		const tail = parseIntrospectTail(cursor);
		const endSpan =
			tail.stages.length > 0
				? tail.stages[tail.stages.length - 1]!.span
				: subTok.span;
		return {
			operation: "introspect",
			kind: "list-schema-events",
			...(tail.stages.length > 0 ? { stages: tail.stages } : {}),
			span: { start: listTok.span.start, end: endSpan.end }
		};
	}
	throw new SnqlError(
		`'list' attend une sous-commande connue (tables / schemas / indexes / databases / schema_events), trouvé '${sub.value}'`,
		"parse_introspect_unknown_list",
		sub.span
	);
}

/**
 * `let x1 = find …; let x2 = find x1 …; <body>` — CTE.
 * Consomme les bindings tant qu'un `let` suit (chacun terminé par `;`), puis
 * parse le body (find/add/update/remove). Body = transaction/raw/introspect
 * refusé (pas de sémantique claire v1 — refus explicit avec code).
 */
function parseLet(cursor: TokenCursor): LetStatement {
	const bindings: LetBinding[] = [];
	const firstTok = cursor.peek();
	while (
		cursor.peek().kind === "ident" &&
		cursor.peek().value.toLowerCase() === "let"
	) {
		bindings.push(parseLetBinding(cursor));
	}
	// Le body doit être find / add / update / remove — pas transaction/raw/list/describe.
	const bodyStart = cursor.peek();
	const body = parseStatement(cursor);
	checkNoDanglingUnionAll(cursor);
	if (
		body.operation === "let" ||
		body.operation === "transaction" ||
		body.operation === "introspect" ||
		body.operation === "raw" ||
		body.operation === "ddl"
	) {
		throw new SnqlError(
			`'${body.operation}' non supporté comme body d'un 'let' v1 — utilise find / add / update / remove.`,
			"parse_let_body_unsupported",
			bodyStart.span
		);
	}
	const lastBinding = bindings[bindings.length - 1]!;
	return {
		operation: "let",
		bindings,
		body,
		span: {
			start: firstTok.span.start,
			end: body.span?.end ?? lastBinding.span.end
		}
	};
}

/**
 * Un binding `let <ident> = <query>;` (kind: 'plain') OU
 * `let rec <ident> = <base> union all <step>;` (kind: 'recursive'). `rec` est
 * soft-keyword contextuel (ident après `let`), `union` et `all` idem.
 */
function parseLetBinding(cursor: TokenCursor): LetBinding {
	const letTok = cursor.next(); // `let`
	const nextTok = cursor.peek();
	const isRecursive =
		nextTok.kind === "ident" && nextTok.value.toLowerCase() === "rec";
	if (isRecursive) {
		cursor.next(); // `rec`
	}
	const nameTok = cursor.peek();
	if (nameTok.kind !== "ident") {
		if (isRecursive && nameTok.kind === "op" && nameTok.value === "=") {
			throw new SnqlError(
				`'let rec' attend un nom de CTE avant '=' — 'rec' est réservé après 'let'.`,
				"parse_let_rec_reserved_name",
				nameTok.span
			);
		}
		throw new SnqlError(
			`'let${isRecursive ? " rec" : ""}' attend un nom de CTE, trouvé '${nameTok.value}'`,
			"parse_let_missing_name",
			nameTok.span
		);
	}
	cursor.next();
	const eq = cursor.peek();
	if (eq.kind !== "op" || eq.value !== "=") {
		throw new SnqlError(
			`'let${isRecursive ? " rec" : ""} ${nameTok.value}' attend '=', trouvé '${eq.value}'`,
			"parse_let_missing_eq",
			eq.span
		);
	}
	cursor.next();

	if (isRecursive) {
		return parseLetRecBody(cursor, letTok.span.start, nameTok.value);
	}

	// Le body du binding est TOUJOURS une query select — pas de let{mutation}.
	const bodyStart = cursor.peek();
	const bodyStmt = parseStatement(cursor);
	if (bodyStmt.operation !== "select") {
		throw new SnqlError(
			`'let ${nameTok.value} =' attend une requête 'find' (le CTE est immutable) — reçu '${bodyStmt.operation}'.`,
			"parse_let_binding_not_select",
			bodyStart.span
		);
	}
	const sep = cursor.peek();
	if (sep.kind !== "semicolon") {
		throw new SnqlError(
			`';' attendu après 'let ${nameTok.value} = …' (avant le prochain 'let' ou le body).`,
			"parse_let_missing_semicolon",
			sep.span
		);
	}
	cursor.next();
	return {
		kind: "plain",
		name: nameTok.value,
		query: bodyStmt,
		span: { start: letTok.span.start, end: sep.span.end }
	};
}

/**
 * Corps d'un `let rec <name> = <base> union all <step>;`. `union` et `all`
 * sont soft-keywords contextuels (idents ici). L'ADR-021 v2 exige `union all`
 * uniquement (pas `union` dedup, pas de branches multiples). Précédence :
 * `where/sort/limit/pick` après `union all find B` s'attache au step seul
 * (SQL standard).
 */
function parseLetRecBody(
	cursor: TokenCursor,
	startPos: import("../lexer/token").Position,
	name: string
): LetBinding {
	const baseStart = cursor.peek();
	const baseStmt = parseStatement(cursor);
	if (baseStmt.operation !== "select") {
		throw new SnqlError(
			`'let rec ${name} =' attend une requête 'find' comme base — reçu '${baseStmt.operation}'.`,
			"parse_let_rec_binding_not_select",
			baseStart.span
		);
	}
	const unionTok = cursor.peek();
	if (unionTok.kind !== "ident" || unionTok.value.toLowerCase() !== "union") {
		throw new SnqlError(
			`'let rec ${name}' attend 'union all' après la base, trouvé '${unionTok.value}'.`,
			"parse_let_rec_missing_union",
			unionTok.span
		);
	}
	cursor.next(); // `union`
	const allTok = cursor.peek();
	if (allTok.kind !== "ident" || allTok.value.toLowerCase() !== "all") {
		throw new SnqlError(
			`'union' seul non supporté v1 (dedup coûteuse) — utilise 'union all'.`,
			"parse_let_rec_union_needs_all",
			allTok.span
		);
	}
	cursor.next(); // `all`
	const stepStart = cursor.peek();
	const stepStmt = parseStatement(cursor);
	if (stepStmt.operation !== "select") {
		throw new SnqlError(
			`'let rec ${name} = base union all' attend une requête 'find' comme step — reçu '${stepStmt.operation}'.`,
			"parse_let_rec_binding_not_select",
			stepStart.span
		);
	}
	const extraUnion = cursor.peek();
	if (
		extraUnion.kind === "ident" &&
		extraUnion.value.toLowerCase() === "union"
	) {
		throw new SnqlError(
			`'let rec ${name}' n'accepte qu'une paire base+step — wrap plusieurs branches sous un seul 'union all'`,
			"parse_let_rec_multiple_union_all",
			extraUnion.span
		);
	}
	const sep = cursor.peek();
	if (sep.kind !== "semicolon") {
		throw new SnqlError(
			`';' attendu après 'let rec ${name} = base union all step' (avant le prochain 'let' ou le body).`,
			"parse_let_rec_missing_step",
			sep.span
		);
	}
	cursor.next();
	return {
		kind: "recursive",
		name,
		base: baseStmt,
		step: stepStmt,
		span: { start: startPos, end: sep.span.end }
	};
}

/**
 * Check global : refuser `union all` détecté ailleurs qu'à l'intérieur d'un
 * `let rec` (le parseur de statement principal ne connaît pas ce séquenceur —
 * il apparaîtrait comme un ident indésirable). Appelé après un parseStatement
 * réussi pour lever un erreur ciblée.
 */
function checkNoDanglingUnionAll(cursor: TokenCursor): void {
	const tok = cursor.peek();
	if (tok.kind !== "ident" || tok.value.toLowerCase() !== "union") return;
	const next = cursor.peek(1);
	if (next.kind === "ident" && next.value.toLowerCase() === "all") {
		throw new SnqlError(
			`'union all' réservé à 'let rec X = base union all step'.`,
			"parse_union_all_outside_let_rec",
			tok.span
		);
	}
}

/**
 * `raw "SQL"` (PG) ou `raw {...}` (Mongo command). Le payload
 * lève l'ambiguïté PG-vs-Mongo par shape : string → SQL, object literal →
 * Mongo command. Aucun stage n'est autorisé après (raw = statement complet).
 * L'accord engine-payload est vérifié par le mapper (refus cross-shape).
 */
function parseRaw(cursor: TokenCursor): RawStatement {
	const rawTok = cursor.next(); // `raw`
	const payloadTok = cursor.peek();
	if (payloadTok.kind === "string") {
		cursor.next();
		return {
			operation: "raw",
			payload: {
				kind: "sql",
				text: payloadTok.value,
				textSpan: payloadTok.span
			},
			span: { start: rawTok.span.start, end: payloadTok.span.end }
		};
	}
	if (payloadTok.kind === "lbrace") {
		// Object literal SNQL — l'expression parseur le lit sous forme Expr.object,
		// qu'on garde tel quel dans le payload. Le codegen Mongo l'évalue en
		// document littéral au moment du mapping.
		const objectExpr = parseExpression(cursor);
		if (objectExpr.type !== "object") {
			throw new SnqlError(
				`'raw {' attend un object literal Mongo, forme reçue '${objectExpr.type}'`,
				"parse_raw_expected_object",
				objectExpr.span
			);
		}
		return {
			operation: "raw",
			payload: {
				kind: "mongo",
				command: objectExpr,
				commandSpan: objectExpr.span
			},
			span: { start: rawTok.span.start, end: objectExpr.span.end }
		};
	}
	throw new SnqlError(
		`'raw' attend un texte SQL ("...") ou une command Mongo ({...}), trouvé '${payloadTok.value}'`,
		"parse_raw_missing_payload",
		payloadTok.span
	);
}

/**
 * `describe <table>` — introspection colonnes.
 * Retourne un shape stable {name, type, nullable, default, is_primary_key,
 * foreign_key} — cohérent PG/Mongo pour que l'UI n'ait pas à brancher
 * sur l'engine.
 */
function parseIntrospectDescribe(cursor: TokenCursor): IntrospectStatement {
	const descTok = cursor.next(); // `describe`
	const target = cursor.peek();
	if (target.kind !== "ident") {
		throw new SnqlError(
			`'describe' attend un nom de table, trouvé '${target.value}'`,
			"parse_introspect_describe_missing_target",
			target.span
		);
	}
	cursor.next();
	const tail = parseIntrospectTail(cursor);
	const endSpan =
		tail.stages.length > 0
			? tail.stages[tail.stages.length - 1]!.span
			: target.span;
	return {
		operation: "introspect",
		kind: "describe-table",
		target: target.value,
		...(tail.stages.length > 0 ? { stages: tail.stages } : {}),
		span: { start: descTok.span.start, end: endSpan.end }
	};
}

/**
 * `for <col1>, <col2>, ...` — sucre parseur qui désucre en
 * `where name in ["col1", "col2", ...]`. Utile pour cibler des rows précises
 * d'un `describe` ou `list` sans écrire le prédicat verbeux. `for` est un
 * soft-keyword contextuel (non ajouté à KEYWORDS pour rester utilisable en
 * ident ailleurs — ex. col nommée `for`).
 */
function parseIntrospectForShortcut(cursor: TokenCursor): Stage {
	const forTok = cursor.next(); // `for`
	const names: { value: string; span: import("../lexer/token").Span }[] = [];
	for (;;) {
		const nameTok = cursor.peek();
		if (nameTok.kind !== "ident") {
			throw new SnqlError(
				`'for' attend une liste de noms de colonnes, trouvé '${nameTok.value}'`,
				"parse_introspect_for_missing_name",
				nameTok.span
			);
		}
		cursor.next();
		names.push({ value: nameTok.value, span: nameTok.span });
		if (cursor.peek().kind !== "comma") break;
		cursor.next();
	}
	const lastSpan = names[names.length - 1]!.span;
	const span = { start: forTok.span.start, end: lastSpan.end };
	const predicate: Expr = {
		type: "in",
		target: { type: "field", path: ["name"], span },
		values: names.map((n) => ({
			type: "literal" as const,
			value: { kind: "string" as const, value: n.value },
			span: n.span
		})),
		span
	};
	return { type: "where", predicate, span };
}

/**
 * parse la suite `where`/`pick`/`sort`/`limit` d'une commande
 * d'introspection. Ordre canonique aligné avec un `find` (parser + lower
 * réutilisent la même infra pour typecheck alias / stage order).
 *
 * Stages refusés v1 : `with`, `group`, `having` — l'introspection produit un
 * dataset autonome (pas de join possible sans schéma virtuel du shape, pas
 * d'aggregation pertinente sur 20 rows de metadata). Le rejet est explicite
 * (`parse_introspect_stage_unsupported`) pour orienter l'utilisateur.
 */
function parseIntrospectTail(cursor: TokenCursor): { stages: Stage[] } {
	const stages: Stage[] = [];
	// Refuse les stages hors périmètre AVANT de parser — sinon `describe t with`
	// consomme `with` en tentant de le parser et casse avec un message obscur.
	const unsupported = new Set(["with", "group", "having"]);
	const peekedFirst = cursor.peek();
	if (peekedFirst.kind === "keyword" && unsupported.has(peekedFirst.value)) {
		throw new SnqlError(
			`'${peekedFirst.value}' non supporté après une commande d'introspection — v1 : where / pick / sort / limit.`,
			"parse_introspect_stage_unsupported",
			peekedFirst.span
		);
	}
	// `for a, b, ...` — filter shortcut sur le nom de col/table.
	// Soft-keyword contextuel : `for` n'est jamais dans KEYWORDS (pas de
	// conflit avec les usages ident ailleurs). Ordre canonique impose
	// `for` avant `where` — s'il vient après on refuse (message dédié).
	if (
		peekedFirst.kind === "ident" &&
		peekedFirst.value.toLowerCase() === "for"
	) {
		stages.push(parseIntrospectForShortcut(cursor));
	}
	if (peekKeyword(cursor, "where")) stages.push(parseWhere(cursor));
	if (peekKeyword(cursor, "pick")) stages.push(parsePick(cursor));
	if (peekKeyword(cursor, "sort")) stages.push(parseSort(cursor));
	if (peekKeyword(cursor, "limit")) stages.push(parseLimit(cursor));
	// Un `for` post-where/pick/sort/limit = ordre violé.
	const trailing = cursor.peek();
	if (trailing.kind === "ident" && trailing.value.toLowerCase() === "for") {
		throw new SnqlError(
			"'for' doit précéder les stages classiques — écris 'describe t for a, b [where ...]'",
			"parse_introspect_for_out_of_order",
			trailing.span
		);
	}
	// Un stage encore présent après le parse dans l'ordre = ordre violé.
	rejectTrailingStage(cursor, new Set(["where", "pick", "sort", "limit"]), [
		"where",
		"pick",
		"sort",
		"limit"
	]);
	return { stages };
}

/**
 * `transaction [isolation <level>] { stmt; stmt; ... }`.
 * `;` obligatoire entre statements (robuste au copier-coller). `{}` vide
 * refusé (transaction sans op = no-op silencieuse, pas de valeur ajoutée).
 */
function parseTransaction(cursor: TokenCursor): TransactionStatement {
	const txTok = cursor.next(); // `transaction`
	let isolation: IsolationLevel | undefined;
	if (peekKeyword(cursor, "isolation")) {
		cursor.next();
		isolation = parseIsolationLevel(cursor);
	}
	cursor.expect("lbrace", "'{' pour ouvrir le bloc transaction");
	const body: TransactionBodyItem[] = [];
	if (cursor.peek().kind === "rbrace") {
		throw new SnqlError(
			"'transaction { }' vide refusé — un bloc atomique doit contenir au moins un statement.",
			"parse_transaction_empty",
			cursor.peek().span
		);
	}
	for (;;) {
		body.push(parseTransactionItem(cursor));
		const sep = cursor.peek();
		if (sep.kind === "semicolon") {
			cursor.next();
			// `;` suivi de `}` = trailing ; toléré (comme JS).
			if (cursor.peek().kind === "rbrace") break;
			continue;
		}
		if (sep.kind === "rbrace") {
			// Dernier stmt sans `;` trailing — accepté (le `;` n'est
			// obligatoire qu'ENTRE stmts, pas en fin de bloc).
			break;
		}
		throw new SnqlError(
			"';' attendu entre statements d'un bloc transaction (robuste au copier-coller).",
			"parse_transaction_missing_semicolon",
			sep.span
		);
	}
	const close = cursor.expect("rbrace", "'}' pour fermer le bloc transaction");
	const span = { start: txTok.span.start, end: close.span.end };
	return isolation !== undefined
		? { operation: "transaction", isolation, body, span }
		: { operation: "transaction", body, span };
}

/**
 * lit `isolation <level>` post-keyword. Levels : `read
 * committed`, `repeatable read`, `serializable` (case-insensitive côté
 * lexer). `read` est ident soft-keyword ici (pas de reserved word global
 * pour ne pas casser les cols nommées `read`).
 */
function parseIsolationLevel(cursor: TokenCursor): IsolationLevel {
	const first = cursor.next();
	const firstVal = first.value.toLowerCase();
	if (first.kind === "keyword" && first.value === "serializable") {
		return "serializable";
	}
	if (first.kind === "keyword" && first.value === "repeatable") {
		const next = cursor.next();
		if (
			(next.kind === "ident" && next.value.toLowerCase() === "read") ||
			(next.kind === "keyword" && next.value === "read")
		) {
			return "repeatable_read";
		}
		throw new SnqlError(
			`'isolation repeatable' attend 'read' (repeatable read), trouvé '${next.value}'`,
			"parse_isolation_level",
			next.span
		);
	}
	// `isolation read committed` : `read` peut être ident ou keyword.
	if (firstVal === "read") {
		const next = cursor.next();
		if (next.kind === "keyword" && next.value === "committed") {
			return "read_committed";
		}
		throw new SnqlError(
			`'isolation read' attend 'committed' (read committed), trouvé '${next.value}'`,
			"parse_isolation_level",
			next.span
		);
	}
	throw new SnqlError(
		`'isolation' attend 'read committed', 'repeatable read' ou 'serializable', trouvé '${first.value}'`,
		"parse_isolation_level",
		first.span
	);
}

/**
 * un item de body de transaction. Soit un statement classique
 * (select/insert/update/delete), soit un savepoint bloc. Refus transaction
 * nested (parseStatement pourrait recurser sinon).
 */
function parseTransactionItem(cursor: TokenCursor): TransactionBodyItem {
	const first = cursor.peek();
	if (first.kind === "keyword" && first.value === "transaction") {
		throw new SnqlError(
			"Transactions imbriquées interdites — utilise `savepoint <name> { ... }` pour un rollback partiel.",
			"parse_transaction_nested",
			first.span
		);
	}
	if (first.kind === "keyword" && first.value === "savepoint") {
		return parseSavepoint(cursor);
	}
	const stmt = parseStatement(cursor);
	// parseStatement pour un verb retourne un Statement — filtre les savepoints
	// (impossible : savepoint n'est pas un verb) et transactions (déjà bloquées
	// ci-dessus). TS narrowing garanti.
	if (stmt.operation === "transaction") {
		throw new SnqlError(
			"Transactions imbriquées interdites (bug parseStatement — devrait avoir été bloqué).",
			"parse_transaction_nested",
			first.span
		);
	}
	// introspection interdite dans une transaction (pas de
	// sémantique claire — `list tables` retourne un shape stable, mais son
	// placement dans un bloc atomique n'apporte rien vs l'exécuter à part).
	if (stmt.operation === "introspect") {
		throw new SnqlError(
			"Introspection ('list', 'describe') interdite dans une transaction — exécute-la à part.",
			"parse_introspect_in_transaction",
			first.span
		);
	}
	// `raw` interdit dans une transaction — SNQL ne parse pas
	// le contenu du raw, donc ne peut pas garantir l'atomicité de son effet
	// vs les autres stmts. L'user peut wrapper son SQL brut avec BEGIN/COMMIT
	// dans la chaîne s'il en a besoin.
	if (stmt.operation === "raw") {
		throw new SnqlError(
			"'raw' interdit dans une transaction — SNQL ne parse pas le contenu, l'atomicité n'est pas garantie. Utilise BEGIN/COMMIT directement dans le SQL brut.",
			"parse_raw_in_transaction",
			first.span
		);
	}
	// `let` interdit dans une transaction v1 — scope des CTE
	// vs multi-stmt atomique ambigu. Chaque stmt de la transaction peut
	// avoir ses propres let en préfixe si besoin.
	if (stmt.operation === "let") {
		throw new SnqlError(
			"'let' interdit dans une transaction v1 — mets les 'let' à l'intérieur de chaque statement individuel.",
			"parse_let_in_transaction",
			first.span
		);
	}
	// DDL interdit dans une transaction v1 (ADR-029). PG natif l'accepterait
	// (BEGIN; CREATE TABLE …; INSERT …; COMMIT;) mais Mongo n'a pas
	// d'atomicité DDL équivalente — refus V1 pour cohérence cross-engine ;
	// à réévaluer si un pattern user réel remonte.
	if (stmt.operation === "ddl") {
		throw new SnqlError(
			"DDL ('create table', ...) interdit dans une transaction v1 — exécute-le à part (Mongo n'a pas d'atomicité DDL équivalente à PG).",
			"parse_ddl_in_transaction",
			first.span
		);
	}
	return stmt;
}

/**
 * `savepoint <name> { stmt; stmt; ... }`. Réutilise la logique
 * de séparateur `;` obligatoire. Savepoints imbriqués autorisés (utile pour
 * rollback multi-niveaux).
 */
function parseSavepoint(cursor: TokenCursor): SavepointStatement {
	const spTok = cursor.next(); // `savepoint`
	const nameTok = cursor.expect(
		"ident",
		"un nom de savepoint après 'savepoint'"
	);
	cursor.expect("lbrace", "'{' pour ouvrir le bloc savepoint");
	const body: TransactionBodyItem[] = [];
	if (cursor.peek().kind === "rbrace") {
		throw new SnqlError(
			"'savepoint " +
				nameTok.value +
				" { }' vide refusé — le savepoint doit contenir au moins un statement.",
			"parse_savepoint_empty",
			cursor.peek().span
		);
	}
	for (;;) {
		body.push(parseTransactionItem(cursor));
		const sep = cursor.peek();
		if (sep.kind === "semicolon") {
			cursor.next();
			if (cursor.peek().kind === "rbrace") break;
			continue;
		}
		if (sep.kind === "rbrace") {
			// Dernier stmt sans `;` trailing — accepté (parité transaction).
			break;
		}
		throw new SnqlError(
			"';' attendu entre statements d'un bloc savepoint (parité transaction).",
			"parse_savepoint_missing_semicolon",
			sep.span
		);
	}
	const close = cursor.expect("rbrace", "'}' pour fermer le bloc savepoint");
	const span = { start: spTok.span.start, end: close.span.end };
	return { operation: "savepoint", name: nameTok.value, body, span };
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

// ─── DDL Tier-2 (ADR-029) ───────────────────────────────────────────────
// V1 corpus = `create table T [if not exists] { field: type [nullable]
// [default v] [unique], ..., primary key (f1, f2) }`. D0 exception body
// motivée (deuxième après `transaction { }`) — règle stricte : body accepté
// UNIQUEMENT sur create table v1.

/** Alias types natifs PG paste-friendly (D6). `varchar(N)` accepté comme ident
 * bare `varchar` — le `(N)` optionnel après reste à parser v-next (ignoré au
 * lower pour l'instant, cohérent avec `text`). Tous les alias normalisent vers
 * un SnqlType canonique déjà supporté par `packages/snql/src/schema/model.ts`.
 * Exporté pour permettre à l'autocomplete (DDL/5) de suggérer les mêmes
 * étiquettes que le parser accepte — source unique. */
export const SNQL_TYPE_ALIAS: Readonly<Record<string, SnqlType>> = {
	string: "string",
	int: "int",
	bigint: "bigint",
	float: "float",
	decimal: "decimal",
	bool: "bool",
	date: "date",
	json: "json",
	array: "array",
	uuid: "uuid",
	enum: "enum",
	unknown: "unknown",
	text: "string",
	varchar: "string",
	int4: "int",
	int8: "bigint",
	integer: "int",
	jsonb: "json",
	timestamp: "date",
	timestamptz: "date",
	numeric: "decimal",
	real: "float",
	double: "float",
	serial: "int",
	bigserial: "bigint",
	boolean: "bool"
};

/**
 * Résout un ident type en `DDLFieldTypeRef` — soit builtin (matched dans
 * SNQL_TYPE_ALIAS), soit enum-ref laissé au lower pour lookup via
 * `schema.enums` (ADR-030 Enum/2). Le parser ne throw plus sur type inconnu :
 * le lower décide.
 */
function parseFieldTypeRef(raw: string): DDLFieldTypeRef {
	const t = SNQL_TYPE_ALIAS[raw.toLowerCase()];
	if (t !== undefined) return { kind: "builtin", type: t };
	// Case-preserving pour enum-ref : `Role` != `role` côté PG (bien que PG
	// downcase par défaut ; le lower/codegen quote pour préserver).
	return { kind: "enum-ref", name: raw };
}

function parseCreateTable(cursor: TokenCursor): CreateTableStmt {
	const createTok = cursor.next(); // `create` verb
	cursor.next(); // `table` keyword (déjà peeked au dispatch)

	// `if not exists` optionnel (D3 — name-only sémantique cross-engine, drift
	// schéma NON détecté, documenté dans ADR-029 D3 + `divergences.yaml`).
	let ifNotExists = false;
	const maybeIf = cursor.peek();
	if (maybeIf.kind === "ident" && maybeIf.value.toLowerCase() === "if") {
		cursor.next();
		if (!peekKeyword(cursor, "not")) {
			throw new SnqlError(
				"'if' doit être suivi de 'not exists' dans un create table",
				"parse_ddl_expected_not_after_if",
				cursor.peek().span
			);
		}
		cursor.next();
		if (!peekKeyword(cursor, "exists")) {
			throw new SnqlError(
				"'if not' doit être suivi de 'exists' dans un create table",
				"parse_ddl_expected_exists_after_not",
				cursor.peek().span
			);
		}
		cursor.next();
		ifNotExists = true;
	}

	const targetTok = cursor.expect(
		"ident",
		"un nom de table après 'create table'"
	);
	const target = targetTok.value;

	// Body `{ field: type ..., primary key (...) }` — D0 exception.
	cursor.expect("lbrace", "'{' pour ouvrir le body du create table");

	const fields: DDLFieldDef[] = [];
	let primaryKey: readonly string[] | undefined;
	const seenFieldNames = new Set<string>();

	if (cursor.peek().kind !== "rbrace") {
		for (;;) {
			if (peekKeyword(cursor, "primary")) {
				if (primaryKey !== undefined) {
					throw new SnqlError(
						"'primary key' déclaré deux fois dans le body",
						"parse_ddl_primary_key_duplicate",
						cursor.peek().span
					);
				}
				primaryKey = parsePrimaryKeyClause(cursor);
			} else {
				const field = parseCreateTableField(cursor);
				if (seenFieldNames.has(field.name)) {
					throw new SnqlError(
						`Field dupliqué '${field.name}' dans le body du create table`,
						"parse_ddl_field_duplicate",
						field.span
					);
				}
				seenFieldNames.add(field.name);
				fields.push(field);
			}
			const nxt = cursor.peek();
			if (nxt.kind === "comma") {
				cursor.next();
				continue;
			}
			if (nxt.kind === "rbrace") break;
			throw new SnqlError(
				"',' ou '}' attendu",
				"parse_ddl_body_close_expected",
				nxt.span
			);
		}
	}

	const closeBrace = cursor.expect(
		"rbrace",
		"'}' pour fermer le body du create table"
	);

	if (fields.length === 0) {
		throw new SnqlError(
			"'create table' attend au moins un field",
			"parse_ddl_create_table_empty_body",
			{ start: createTok.span.start, end: closeBrace.span.end }
		);
	}

	return {
		operation: "ddl",
		kind: "create-table",
		target,
		ifNotExists,
		fields,
		...(primaryKey !== undefined ? { primaryKey } : {}),
		span: { start: createTok.span.start, end: closeBrace.span.end }
	};
}

function parseCreateTableField(cursor: TokenCursor): DDLFieldDef {
	const nameTok = cursor.expect("ident", "un nom de field dans le body");
	cursor.expect("colon", "':' entre le nom du field et son type");
	const typeTok = cursor.expect(
		"ident",
		"un type SNQL (uuid/string/int/...), alias PG (varchar/jsonb/...) ou nom d'enum"
	);
	const type = parseFieldTypeRef(typeTok.value);

	// Modifiers optionnels : `nullable` | `not null` | `default <expr>` | `unique`
	let nullable: boolean | undefined;
	let defaultExpr: Expr | undefined;
	let unique = false;
	let endSpan: Span = typeTok.span;

	for (;;) {
		const nxt = cursor.peek();
		const v = nxt.value.toLowerCase();
		if (nxt.kind === "ident" && v === "nullable") {
			cursor.next();
			nullable = true;
			endSpan = nxt.span;
		} else if (nxt.kind === "keyword" && v === "not") {
			cursor.next();
			const nullTok = cursor.peek();
			// `null` est tokenizé comme literal (kind === "null"), pas ident.
			const isNullTok =
				nullTok.kind === "null" ||
				(nullTok.kind === "ident" && nullTok.value.toLowerCase() === "null");
			if (!isNullTok) {
				throw new SnqlError(
					"'not' doit être suivi de 'null' (alias SQL pour non-nullable)",
					"parse_ddl_expected_null_after_not",
					nullTok.span
				);
			}
			cursor.next();
			nullable = false;
			endSpan = nullTok.span;
		} else if (nxt.kind === "keyword" && v === "default") {
			cursor.next();
			defaultExpr = parseExpression(cursor);
			endSpan = defaultExpr.span;
		} else if (nxt.kind === "ident" && v === "unique") {
			cursor.next();
			unique = true;
			endSpan = nxt.span;
		} else {
			break;
		}
	}

	return {
		name: nameTok.value,
		type,
		typeSpan: typeTok.span,
		...(nullable !== undefined ? { nullable } : {}),
		...(defaultExpr !== undefined ? { defaultExpr } : {}),
		...(unique ? { unique } : {}),
		span: { start: nameTok.span.start, end: endSpan.end }
	};
}

function parsePrimaryKeyClause(cursor: TokenCursor): readonly string[] {
	cursor.next(); // `primary` keyword
	const keyTok = cursor.peek();
	// `key` reste soft-ident (courant en col name), contextuel après `primary`.
	if (keyTok.kind !== "ident" || keyTok.value.toLowerCase() !== "key") {
		throw new SnqlError(
			"'primary' doit être suivi de 'key'",
			"parse_ddl_primary_key_missing_key",
			keyTok.span
		);
	}
	cursor.next();
	cursor.expect("lparen", "'(' après 'primary key'");

	const cols: string[] = [];
	const seen = new Set<string>();
	if (cursor.peek().kind !== "rparen") {
		for (;;) {
			const colTok = cursor.expect(
				"ident",
				"un nom de colonne dans primary key"
			);
			if (seen.has(colTok.value)) {
				throw new SnqlError(
					`Colonne '${colTok.value}' dupliquée dans primary key`,
					"parse_ddl_primary_key_duplicate_col",
					colTok.span
				);
			}
			seen.add(colTok.value);
			cols.push(colTok.value);
			const nxt = cursor.peek();
			if (nxt.kind === "comma") {
				cursor.next();
				continue;
			}
			if (nxt.kind === "rparen") break;
			throw new SnqlError(
				"',' ou ')' attendu dans primary key",
				"parse_ddl_primary_key_close_expected",
				nxt.span
			);
		}
	}
	const closeParen = cursor.expect("rparen", "')' pour fermer primary key");

	if (cols.length === 0) {
		throw new SnqlError(
			"'primary key ()' vide interdit",
			"parse_ddl_primary_key_empty",
			closeParen.span
		);
	}
	return cols;
}

/**
 * `add column <col> <type> [nullable | not null] [default <val>] [unique] [if not exists] into <table>` (DDL/2).
 * `column` reste soft-ident (peekIdent au dispatch — safe pour un field
 * nommé `column` dans un `add {column: "id", ...} into T`). Backfill D10 +
 * preflight D2 sont côté runtime adapter, PAS ici — le parser produit un
 * shape neutre engine.
 */
function parseAddColumn(cursor: TokenCursor): AddColumnStmt {
	const addTok = cursor.next(); // `add` verb
	cursor.next(); // `column` ident (déjà peeked au dispatch)

	// Nom de la colonne à ajouter — même règle IDENT_REGEX D1 que create table.
	// Surface SQL-familière : pas de `:` séparateur (aligné `ALTER TABLE t ADD
	// COLUMN col TYPE`), contrairement au body `create table { col: type }` qui
	// est un object literal.
	const nameTok = cursor.expect("ident", "un nom de colonne après 'add column'");
	const typeTok = cursor.expect(
		"ident",
		"un type SNQL (uuid/string/int/...), alias PG (varchar/jsonb/...) ou nom d'enum"
	);
	const type = parseFieldTypeRef(typeTok.value);

	// Modifiers optionnels — même dispatch que parseCreateTableField.
	// `unique` sur `add column` = équivaut à créer un UNIQUE INDEX secondaire ;
	// V1 on accepte le flag et l'engine adapter décide (PG natif, Mongo
	// createIndex, KV middleware D12). Note : sur Mongo, `unique` = createIndex
	// non atomique avec le collMod — cf. D12.
	let nullable: boolean | undefined;
	let defaultExpr: Expr | undefined;
	let unique = false;
	let endSpan: Span = typeTok.span;
	for (;;) {
		const nxt = cursor.peek();
		const v = nxt.value.toLowerCase();
		if (nxt.kind === "ident" && v === "nullable") {
			cursor.next();
			nullable = true;
			endSpan = nxt.span;
		} else if (nxt.kind === "keyword" && v === "not") {
			cursor.next();
			const nullTok = cursor.peek();
			const isNullTok =
				nullTok.kind === "null" ||
				(nullTok.kind === "ident" && nullTok.value.toLowerCase() === "null");
			if (!isNullTok) {
				throw new SnqlError(
					"'not' doit être suivi de 'null' (alias SQL pour non-nullable)",
					"parse_ddl_expected_null_after_not",
					nullTok.span
				);
			}
			cursor.next();
			nullable = false;
			endSpan = nullTok.span;
		} else if (nxt.kind === "keyword" && v === "default") {
			cursor.next();
			defaultExpr = parseExpression(cursor);
			endSpan = defaultExpr.span;
		} else if (nxt.kind === "ident" && v === "unique") {
			cursor.next();
			unique = true;
			endSpan = nxt.span;
		} else {
			break;
		}
	}

	// `if not exists` optionnel — parsé APRÈS les modifiers pour matcher la
	// grammaire naturelle « add column X int default 0 if not exists into T ».
	// D3 : name-only sémantique cross-engine (drift NON détecté).
	let ifNotExists = false;
	const maybeIf = cursor.peek();
	if (maybeIf.kind === "ident" && maybeIf.value.toLowerCase() === "if") {
		cursor.next();
		if (!peekKeyword(cursor, "not")) {
			throw new SnqlError(
				"'if' doit être suivi de 'not exists' dans un add column",
				"parse_ddl_expected_not_after_if",
				cursor.peek().span
			);
		}
		cursor.next();
		if (!peekKeyword(cursor, "exists")) {
			throw new SnqlError(
				"'if not' doit être suivi de 'exists' dans un add column",
				"parse_ddl_expected_exists_after_not",
				cursor.peek().span
			);
		}
		const existsTok = cursor.next();
		ifNotExists = true;
		endSpan = existsTok.span;
	}

	// Préposition unifiée `into <table>` (D6 ADR-029, aligné DML).
	if (!peekKeyword(cursor, "into")) {
		throw new SnqlError(
			"'add column' attend 'into <table>' pour cibler la table",
			"parse_ddl_add_column_missing_into",
			cursor.peek().span
		);
	}
	cursor.next();
	const targetTok = cursor.expect("ident", "un nom de table après 'into'");

	const column: DDLFieldDef = {
		name: nameTok.value,
		type,
		typeSpan: typeTok.span,
		...(nullable !== undefined ? { nullable } : {}),
		...(defaultExpr !== undefined ? { defaultExpr } : {}),
		...(unique ? { unique } : {}),
		span: { start: nameTok.span.start, end: endSpan.end }
	};
	return {
		operation: "ddl",
		kind: "add-column",
		target: targetTok.value,
		column,
		...(ifNotExists ? { ifNotExists } : {}),
		span: { start: addTok.span.start, end: targetTok.span.end }
	};
}

/**
 * `add [unique] index (<field>[, ...]) [if not exists] into <table>` (DDL/3).
 * `index` reste soft-ident (peekIdent au dispatch). `unique` idem — préserve
 * `count(unique x)` / `pick unique` déjà en place. Le nom d'index est
 * auto-généré au lower si absent (pattern `idx_<table>_<f1_f2>`).
 */
function parseAddIndex(cursor: TokenCursor): AddIndexStmt {
	const addTok = cursor.next(); // `add` verb
	let unique = false;
	if (peekIdent(cursor, "unique")) {
		cursor.next();
		unique = true;
	}
	// `index` soft-ident (déjà peeked au dispatch — on le consomme).
	cursor.next();

	// `(field, field, ...)` — parens obligatoires, au moins un field.
	cursor.expect("lparen", "'(' pour ouvrir la liste de fields de l'index");
	const fields: string[] = [];
	if (cursor.peek().kind === "rparen") {
		throw new SnqlError(
			"'add index' attend au moins un field entre les parens",
			"parse_ddl_index_empty_fields",
			cursor.peek().span
		);
	}
	for (;;) {
		const fieldTok = cursor.expect("ident", "un nom de field dans l'index");
		fields.push(fieldTok.value);
		const nxt = cursor.peek();
		if (nxt.kind === "comma") {
			cursor.next();
			continue;
		}
		if (nxt.kind === "rparen") break;
		throw new SnqlError(
			"',' ou ')' attendu après le field de l'index",
			"parse_ddl_index_field_delim_expected",
			nxt.span
		);
	}
	cursor.expect("rparen", "')' pour fermer la liste de fields de l'index");

	// `if not exists` optionnel (D3 name-only sémantique).
	let ifNotExists = false;
	if (peekIdent(cursor, "if")) {
		cursor.next();
		if (!peekKeyword(cursor, "not")) {
			throw new SnqlError(
				"'if' doit être suivi de 'not exists' dans un add index",
				"parse_ddl_expected_not_after_if",
				cursor.peek().span
			);
		}
		cursor.next();
		if (!peekKeyword(cursor, "exists")) {
			throw new SnqlError(
				"'if not' doit être suivi de 'exists' dans un add index",
				"parse_ddl_expected_exists_after_not",
				cursor.peek().span
			);
		}
		cursor.next();
		ifNotExists = true;
	}

	// Préposition unifiée `into <table>` (D6).
	if (!peekKeyword(cursor, "into")) {
		throw new SnqlError(
			"'add index' attend 'into <table>' pour cibler la table",
			"parse_ddl_add_index_missing_into",
			cursor.peek().span
		);
	}
	cursor.next();
	const targetTok = cursor.expect("ident", "un nom de table après 'into'");

	return {
		operation: "ddl",
		kind: unique ? "add-unique-index" : "add-index",
		target: targetTok.value,
		fields,
		...(ifNotExists ? { ifNotExists } : {}),
		span: { start: addTok.span.start, end: targetTok.span.end }
	};
}

/**
 * `drop index <name> from <table> [if exists]` (DDL/3). Préposition unifiée
 * `from` (D6, aligné DML `remove from T`). Le nom est explicite — l'user
 * passe par `list indexes` pour retrouver un auto-généré.
 */
function parseDropIndex(cursor: TokenCursor): DropIndexStmt {
	const dropTok = cursor.next(); // `drop` soft-ident
	cursor.next(); // `index` soft-ident (déjà peeked au dispatch)

	const nameTok = cursor.expect("ident", "un nom d'index après 'drop index'");

	// Préposition unifiée `from <table>` (D6, aligné DML remove from T).
	if (!peekKeyword(cursor, "from")) {
		throw new SnqlError(
			"'drop index' attend 'from <table>' pour cibler la table",
			"parse_ddl_drop_index_missing_from",
			cursor.peek().span
		);
	}
	cursor.next();
	const targetTok = cursor.expect("ident", "un nom de table après 'from'");

	// `if exists` optionnel (D3 name-only sémantique).
	let ifExists = false;
	if (peekIdent(cursor, "if")) {
		cursor.next();
		if (!peekKeyword(cursor, "exists")) {
			throw new SnqlError(
				"'if' doit être suivi de 'exists' dans un drop index",
				"parse_ddl_expected_exists_after_if",
				cursor.peek().span
			);
		}
		const existsTok = cursor.next();
		ifExists = true;
		void existsTok;
	}

	return {
		operation: "ddl",
		kind: "drop-index",
		target: targetTok.value,
		name: nameTok.value,
		...(ifExists ? { ifExists } : {}),
		span: { start: dropTok.span.start, end: targetTok.span.end }
	};
}

/**
 * `drop table <name> [if exists]` (DDL/4). Destructive — le frontend applique
 * D7 typing UI gate WriteConfirmBar. PG DROP TABLE RESTRICT (safe vs FK).
 * Mongo dropCollection natif. KV compensation SCAN + DEL (wiring V-next).
 */
function parseDropTable(cursor: TokenCursor): DropTableStmt {
	const dropTok = cursor.next(); // `drop` soft-ident
	cursor.next(); // `table` keyword (déjà peeked)
	const targetTok = cursor.expect("ident", "un nom de table après 'drop table'");

	// `if exists` optionnel (D3 name-only sémantique).
	let ifExists = false;
	let endSpan = targetTok.span;
	if (peekIdent(cursor, "if")) {
		cursor.next();
		if (!peekKeyword(cursor, "exists")) {
			throw new SnqlError(
				"'if' doit être suivi de 'exists' dans un drop table",
				"parse_ddl_expected_exists_after_if",
				cursor.peek().span
			);
		}
		endSpan = cursor.next().span;
		ifExists = true;
	}
	return {
		operation: "ddl",
		kind: "drop-table",
		target: targetTok.value,
		...(ifExists ? { ifExists } : {}),
		span: { start: dropTok.span.start, end: endSpan.end }
	};
}

/**
 * `drop column <col> from <table> [if exists]` (DDL/4). Destructive — D7 UI.
 * PG `ALTER TABLE ... DROP COLUMN ... RESTRICT`. Mongo compensation (collMod
 * validator sans property + updateMany `$unset` batched). KV compensation
 * (SCAN + HDEL par row batched, wiring V-next).
 */
/**
 * `create enum <name> [if not exists] { "m1", "m2", ... }` (ADR-030 Enum/1).
 * Body = string literals uniquement, séparés par comma. Non-empty. Dedup
 * member = refus au lower. Le nom de l'enum est libre (Q1 tranché — pas de
 * convention imposée).
 */
function parseCreateEnum(cursor: TokenCursor): CreateEnumStmt {
	const createTok = cursor.next(); // `create` verb
	cursor.next(); // `enum` ident (déjà peeked au dispatch)

	let ifNotExists = false;
	if (peekIdent(cursor, "if")) {
		cursor.next();
		if (!peekKeyword(cursor, "not")) {
			throw new SnqlError(
				"'if' doit être suivi de 'not exists' dans un create enum",
				"parse_ddl_expected_not_after_if",
				cursor.peek().span
			);
		}
		cursor.next();
		if (!peekKeyword(cursor, "exists")) {
			throw new SnqlError(
				"'if not' doit être suivi de 'exists' dans un create enum",
				"parse_ddl_expected_exists_after_not",
				cursor.peek().span
			);
		}
		cursor.next();
		ifNotExists = true;
	}

	const nameTok = cursor.expect(
		"ident",
		"un nom d'enum après 'create enum'"
	);

	cursor.expect("lbrace", "'{' pour ouvrir le body du create enum");

	const members: string[] = [];
	if (cursor.peek().kind !== "rbrace") {
		for (;;) {
			const memberTok = cursor.peek();
			if (memberTok.kind !== "string") {
				throw new SnqlError(
					"Un member d'enum doit être un string literal — ex : \"user\"",
					"parse_ddl_enum_member_not_string",
					memberTok.span
				);
			}
			cursor.next();
			members.push(memberTok.value);
			const nxt = cursor.peek();
			if (nxt.kind === "comma") {
				cursor.next();
				continue;
			}
			if (nxt.kind === "rbrace") break;
			throw new SnqlError(
				"',' ou '}' attendu",
				"parse_ddl_enum_body_close_expected",
				nxt.span
			);
		}
	}

	const closeBrace = cursor.expect(
		"rbrace",
		"'}' pour fermer le body du create enum"
	);

	if (members.length === 0) {
		throw new SnqlError(
			"'create enum' attend au moins un member",
			"parse_ddl_create_enum_empty_body",
			{ start: createTok.span.start, end: closeBrace.span.end }
		);
	}

	return {
		operation: "ddl",
		kind: "create-enum",
		name: nameTok.value,
		members,
		...(ifNotExists ? { ifNotExists } : {}),
		span: { start: createTok.span.start, end: closeBrace.span.end }
	};
}

/**
 * `add enum member <Name> "member" [if not exists]` (ADR-030 Enum/3). Append-only
 * safe cross-engine. `if not exists` optionnel — sans le modifier, dedup silence
 * au lower (D3 pattern miroir create-table).
 */
function parseAddEnumMember(cursor: TokenCursor): AddEnumMemberStmt {
	const addTok = cursor.next(); // `add` verb
	cursor.next(); // `enum` ident (peeked)
	cursor.next(); // `member` ident (peeked)

	const nameTok = cursor.expect(
		"ident",
		"un nom d'enum après 'add enum member'"
	);

	const memberTok = cursor.peek();
	if (memberTok.kind !== "string") {
		throw new SnqlError(
			'Un member d\'enum doit être un string literal — ex : "user"',
			"parse_ddl_enum_member_not_string",
			memberTok.span
		);
	}
	cursor.next();

	let ifNotExists = false;
	let endSpan = memberTok.span;
	if (peekIdent(cursor, "if")) {
		cursor.next();
		if (!peekKeyword(cursor, "not")) {
			throw new SnqlError(
				"'if' doit être suivi de 'not exists' dans un add enum member",
				"parse_ddl_expected_not_after_if",
				cursor.peek().span
			);
		}
		cursor.next();
		if (!peekKeyword(cursor, "exists")) {
			throw new SnqlError(
				"'if not' doit être suivi de 'exists' dans un add enum member",
				"parse_ddl_expected_exists_after_not",
				cursor.peek().span
			);
		}
		endSpan = cursor.next().span;
		ifNotExists = true;
	}

	return {
		operation: "ddl",
		kind: "add-enum-member",
		name: nameTok.value,
		member: memberTok.value,
		memberSpan: memberTok.span,
		...(ifNotExists ? { ifNotExists } : {}),
		span: { start: addTok.span.start, end: endSpan.end }
	};
}

/**
 * `drop enum <name> [if exists] [cascade]` (ADR-030 Enum/3 D8). Destructive —
 * D7 typing gate frontend. RESTRICT natif PG par défaut (refuse si enum
 * utilisé) ; CASCADE explicite drop les colonnes utilisatrices.
 */
function parseDropEnum(cursor: TokenCursor): DropEnumStmt {
	const dropTok = cursor.next(); // `drop` soft-ident
	cursor.next(); // `enum` soft-ident (peeked)
	const nameTok = cursor.expect(
		"ident",
		"un nom d'enum après 'drop enum'"
	);

	let ifExists = false;
	let cascade = false;
	let endSpan = nameTok.span;

	if (peekIdent(cursor, "if")) {
		cursor.next();
		if (!peekKeyword(cursor, "exists")) {
			throw new SnqlError(
				"'if' doit être suivi de 'exists' dans un drop enum",
				"parse_ddl_expected_exists_after_if",
				cursor.peek().span
			);
		}
		endSpan = cursor.next().span;
		ifExists = true;
	}

	if (peekIdent(cursor, "cascade")) {
		endSpan = cursor.next().span;
		cascade = true;
	}

	return {
		operation: "ddl",
		kind: "drop-enum",
		name: nameTok.value,
		...(ifExists ? { ifExists } : {}),
		...(cascade ? { cascade } : {}),
		span: { start: dropTok.span.start, end: endSpan.end }
	};
}

function parseDropColumn(cursor: TokenCursor): DropColumnStmt {
	const dropTok = cursor.next(); // `drop` soft-ident
	cursor.next(); // `column` soft-ident (déjà peeked)
	const colTok = cursor.expect("ident", "un nom de colonne après 'drop column'");

	if (!peekKeyword(cursor, "from")) {
		throw new SnqlError(
			"'drop column' attend 'from <table>' pour cibler la table",
			"parse_ddl_drop_column_missing_from",
			cursor.peek().span
		);
	}
	cursor.next();
	const targetTok = cursor.expect("ident", "un nom de table après 'from'");

	// `if exists` optionnel.
	let ifExists = false;
	let endSpan = targetTok.span;
	if (peekIdent(cursor, "if")) {
		cursor.next();
		if (!peekKeyword(cursor, "exists")) {
			throw new SnqlError(
				"'if' doit être suivi de 'exists' dans un drop column",
				"parse_ddl_expected_exists_after_if",
				cursor.peek().span
			);
		}
		endSpan = cursor.next().span;
		ifExists = true;
	}
	return {
		operation: "ddl",
		kind: "drop-column",
		target: targetTok.value,
		column: colTok.value,
		...(ifExists ? { ifExists } : {}),
		span: { start: dropTok.span.start, end: endSpan.end }
	};
}
