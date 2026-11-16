import { SnqlError } from "../diagnostics";
import type {
	AddEnumMemberStmt,
	AddIndexStmt,
	AddRefStmt,
	CreateEnumStmt,
	DropEnumStmt,
	DropIndexStmt,
	DropRefStmt
} from "./ast";
import type { TokenCursor } from "./cursor";
import { parseFieldRefModifier } from "./parser-ddl";
import { peekIdent, peekKeyword } from "./parser-peek";

/**
 * DDL — index, clés étrangères et enums.
 */

/**
 * `add [unique] index (<field>[, ...]) [if not exists] into <table>` (DDL/3).
 * `index` reste soft-ident (peekIdent au dispatch). `unique` idem — préserve
 * `count(unique x)` / `pick unique` déjà en place. Le nom d'index est
 * auto-généré au lower si absent (pattern `idx_<table>_<f1_f2>`).
 */
export function parseAddIndex(cursor: TokenCursor): AddIndexStmt {
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
export function parseDropIndex(cursor: TokenCursor): DropIndexStmt {
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
 * `add ref (<col>) references <t>.<c> [on delete <rule>] [on update <rule>]
 * [as <name>] into <table>` (ADR-031 corpus, ADR-036 E/1a). Une seule colonne :
 * les FK composites restent hors scope (ADR-031 Q#5).
 */
export function parseAddRef(cursor: TokenCursor): AddRefStmt {
	const addTok = cursor.next(); // `add` verb
	cursor.next(); // `ref` soft-ident (déjà peeked au dispatch)

	cursor.expect("lparen", "'(' avant la colonne de la foreign key");
	const colTok = cursor.expect("ident", "la colonne qui porte la foreign key");
	if (cursor.peek().kind === "comma") {
		throw new SnqlError(
			"'add ref' prend une seule colonne (foreign key composite non supportée)",
			"parse_ddl_add_ref_composite",
			cursor.peek().span
		);
	}
	cursor.expect("rparen", "')' après la colonne de la foreign key");

	if (!peekIdent(cursor, "references")) {
		throw new SnqlError(
			"'add ref (<col>)' attend 'references <table>.<colonne>'",
			"parse_ddl_add_ref_missing_references",
			cursor.peek().span
		);
	}
	const ref = parseFieldRefModifier(cursor, "references");

	// Préposition unifiée `into <table>` (D6 ADR-029, aligné add column).
	if (!peekKeyword(cursor, "into")) {
		throw new SnqlError(
			"'add ref' attend 'into <table>' pour cibler la table porteuse",
			"parse_ddl_add_ref_missing_into",
			cursor.peek().span
		);
	}
	cursor.next();
	const targetTok = cursor.expect("ident", "un nom de table après 'into'");

	return {
		operation: "ddl",
		kind: "add-ref",
		target: targetTok.value,
		column: colTok.value,
		columnSpan: colTok.span,
		ref,
		span: { start: addTok.span.start, end: targetTok.span.end }
	};
}

/**
 * `drop ref <fk_name> from <table> [if exists]` (ADR-031 FK/3). Préposition
 * unifiée `from` (D6). Adressage par nom de contrainte (auto-gen
 * `fk_<t>_<c>_<target>` ou le `as` de la déclaration) — l'autocomplete propose
 * les refs en scope depuis `schema.refs`.
 */
export function parseDropRef(cursor: TokenCursor): DropRefStmt {
	const dropTok = cursor.next(); // `drop` soft-ident
	cursor.next(); // `ref` soft-ident (déjà peeked au dispatch)

	const nameTok = cursor.expect(
		"ident",
		"un nom de foreign key après 'drop ref'"
	);

	// Préposition unifiée `from <table>` (D6, aligné drop index/column).
	if (!peekKeyword(cursor, "from")) {
		throw new SnqlError(
			"'drop ref' attend 'from <table>' pour cibler la table porteuse",
			"parse_ddl_drop_ref_missing_from",
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
				"'if' doit être suivi de 'exists' dans un drop ref",
				"parse_ddl_expected_exists_after_if",
				cursor.peek().span
			);
		}
		cursor.next();
		ifExists = true;
	}

	return {
		operation: "ddl",
		kind: "drop-ref",
		target: targetTok.value,
		name: nameTok.value,
		...(ifExists ? { ifExists } : {}),
		span: { start: dropTok.span.start, end: targetTok.span.end }
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
export function parseCreateEnum(cursor: TokenCursor): CreateEnumStmt {
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

	const nameTok = cursor.expect("ident", "un nom d'enum après 'create enum'");

	cursor.expect("lbrace", "'{' pour ouvrir le body du create enum");

	const members: string[] = [];
	if (cursor.peek().kind !== "rbrace") {
		for (;;) {
			const memberTok = cursor.peek();
			if (memberTok.kind !== "string") {
				throw new SnqlError(
					'Un member d\'enum doit être un string literal — ex : "user"',
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
export function parseAddEnumMember(cursor: TokenCursor): AddEnumMemberStmt {
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
export function parseDropEnum(cursor: TokenCursor): DropEnumStmt {
	const dropTok = cursor.next(); // `drop` soft-ident
	cursor.next(); // `enum` soft-ident (peeked)
	const nameTok = cursor.expect("ident", "un nom d'enum après 'drop enum'");

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
