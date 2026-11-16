import { SnqlError } from "../diagnostics";
import { verbOperation } from "../lexer/dictionary";
import type { Token } from "../lexer/token";
import type {
	IsolationLevel,
	LetBinding,
	LetStatement,
	RawStatement,
	SavepointStatement,
	Statement,
	TransactionBodyItem,
	TransactionStatement
} from "./ast";
import { TokenCursor } from "./cursor";
import { parseExpression } from "./expression";
import {
	parseAddColumn,
	parseAlterColumn,
	parseCreateTable,
	parseDropColumn,
	parseDropTable,
	parseRenameColumn
} from "./parser-ddl";
import {
	parseAddEnumMember,
	parseAddIndex,
	parseAddRef,
	parseCreateEnum,
	parseDropEnum,
	parseDropIndex,
	parseDropRef
} from "./parser-ddl-objects";
import {
	parseIntrospectDescribe,
	parseIntrospectList
} from "./parser-introspect";
import { parseDelete, parseInsert, parseUpdate } from "./parser-mutation";
import { peekIdent, peekKeyword } from "./parser-peek";
import { parseSelect } from "./parser-select";
import { defined } from "../invariant";

export { DDL_DEFAULT_FUNCTIONS, SNQL_TYPE_ALIAS } from "./parser-ddl";

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
	// E/1a : `add ref (<col>) references <t>.<c> … into <table>`. `ref` reste
	// soft-ident (préserve `add {ref: 1} into t`, où `{` suit `add`).
	if (
		first.kind === "verb" &&
		first.value.toLowerCase() === "add" &&
		peekIdent(cursor, "ref", 1)
	) {
		return parseAddRef(cursor);
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
	// FK/3 : `drop ref <fk_name> from <table> [if exists]`. `ref` reste
	// soft-ident (préserve `add {ref: 1} into t` insert alias et le field
	// modifier `ref` en body create-table). Dispatch head-of-statement.
	if (
		first.kind === "ident" &&
		first.value.toLowerCase() === "drop" &&
		peekIdent(cursor, "ref", 1)
	) {
		return parseDropRef(cursor);
	}
	// E/1c : `alter column <table>.<col> <action>`. `alter` reste soft-ident.
	if (
		first.kind === "ident" &&
		first.value.toLowerCase() === "alter" &&
		peekIdent(cursor, "column", 1)
	) {
		return parseAlterColumn(cursor);
	}
	// E/1b : `rename column <table>.<col> to <nouveau>`. `rename` reste
	// soft-ident (une colonne nommée `rename` reste valide ailleurs).
	if (
		first.kind === "ident" &&
		first.value.toLowerCase() === "rename" &&
		peekIdent(cursor, "column", 1)
	) {
		return parseRenameColumn(cursor);
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
	const lastBinding = defined(bindings[bindings.length - 1]);
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
