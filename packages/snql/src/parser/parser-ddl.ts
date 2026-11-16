import { SnqlError } from "../diagnostics";
import type { Span, Token } from "../lexer/token";
import type { SnqlType } from "../schema/model";
import type {
	AddColumnStmt,
	AlterColumnAction,
	AlterColumnStmt,
	CreateTableStmt,
	DDLFieldDef,
	DDLFieldTypeRef,
	DropColumnStmt,
	DropTableStmt,
	Expr,
	FieldRefModifier,
	FieldRefRule,
	RenameColumnStmt
} from "./ast";
import type { TokenCursor } from "./cursor";
import { parseExpression } from "./expression";
import { peekIdent, peekKeyword } from "./parser-peek";

/**
 * DDL — tables et colonnes : créer, ajouter, renommer, modifier, supprimer.
 */

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
 * Défauts fonction admis par le DDL (ADR-036 D4) et types de colonne qui les
 * acceptent. `gen_random_uuid` est l'alias natif de `uuid`. Partagé par le
 * lower et l'autocomplete.
 */
export const DDL_DEFAULT_FUNCTIONS: Readonly<
	Record<string, { fn: "now" | "uuid"; accepts: readonly SnqlType[] }>
> = {
	now: { fn: "now", accepts: ["date"] },
	uuid: { fn: "uuid", accepts: ["uuid", "string"] },
	gen_random_uuid: { fn: "uuid", accepts: ["uuid", "string"] }
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

export function parseCreateTable(cursor: TokenCursor): CreateTableStmt {
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

	// Modifiers optionnels : `nullable` | `not null` | `default <expr>` | `unique` | `ref t.c ...`
	let nullable: boolean | undefined;
	let defaultExpr: Expr | undefined;
	let unique = false;
	let ref: FieldRefModifier | undefined;
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
		} else if (nxt.kind === "ident" && v === "ref") {
			ref = parseFieldRefModifier(cursor);
			endSpan = ref.span;
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
		...(ref !== undefined ? { ref } : {}),
		span: { start: nameTok.span.start, end: endSpan.end }
	};
}

/**
 * `ref <target>.<col> [on delete <rule>] [on update <rule>] [as <name>]`
 * (ADR-031 FK/1). `ref` est déjà peeked (soft-ident). Parse la cible
 * `collection.column`, puis les clauses optionnelles `on delete/update`
 * (rule ∈ cascade|restrict|set null) dans n'importe quel ordre, puis `as`.
 */
export function parseFieldRefModifier(
	cursor: TokenCursor,
	keyword: "ref" | "references" = "ref"
): FieldRefModifier {
	const refTok = cursor.next(); // `ref` / `references` soft-ident
	const targetTok = cursor.expect(
		"ident",
		`une collection cible après '${keyword}' (ex. ${keyword} users.id)`
	);
	if (cursor.peek().kind !== "dot") {
		throw new SnqlError(
			`'${keyword}' attend '<collection>.<colonne>' (ex. ${keyword} users.id)`,
			"parse_ddl_ref_missing_dot",
			cursor.peek().span
		);
	}
	cursor.next(); // dot
	const colTok = cursor.expect(
		"ident",
		`une colonne cible après '.' (ex. ${keyword} users.id)`
	);

	let onDelete: FieldRefRule | undefined;
	let onUpdate: FieldRefRule | undefined;
	let name: string | undefined;
	let endSpan: Span = colTok.span;

	for (;;) {
		if (peekKeyword(cursor, "on")) {
			cursor.next();
			const which = cursor.peek();
			const whichLower = which.value.toLowerCase();
			// `delete` / `update` sont des verbs/idents — matché par valeur.
			if (whichLower !== "delete" && whichLower !== "update") {
				throw new SnqlError(
					"'on' doit être suivi de 'delete' ou 'update' dans une clause ref",
					"parse_ddl_ref_expected_delete_or_update",
					which.span
				);
			}
			cursor.next();
			const rule = parseRefRule(cursor);
			if (whichLower === "delete") {
				if (onDelete !== undefined) {
					throw new SnqlError(
						"'on delete' déclaré deux fois dans la même ref",
						"parse_ddl_ref_duplicate_on_delete",
						which.span
					);
				}
				onDelete = rule.rule;
			} else {
				if (onUpdate !== undefined) {
					throw new SnqlError(
						"'on update' déclaré deux fois dans la même ref",
						"parse_ddl_ref_duplicate_on_update",
						which.span
					);
				}
				onUpdate = rule.rule;
			}
			endSpan = rule.span;
		} else if (peekKeyword(cursor, "as")) {
			cursor.next();
			const nameTok = cursor.expect("ident", "un nom de contrainte après 'as'");
			name = nameTok.value;
			endSpan = nameTok.span;
		} else {
			break;
		}
	}

	return {
		targetCollection: targetTok.value,
		targetColumn: colTok.value,
		...(onDelete !== undefined ? { onDelete } : {}),
		...(onUpdate !== undefined ? { onUpdate } : {}),
		...(name !== undefined ? { name } : {}),
		span: { start: refTok.span.start, end: endSpan.end }
	};
}

/**
 * Parse une règle de cascade : `cascade` | `restrict` | `set null` (deux
 * tokens → `set-null`). Retourne la rule normalisée + le span de fin.
 */
function parseRefRule(cursor: TokenCursor): { rule: FieldRefRule; span: Span } {
	const tok = cursor.peek();
	const v = tok.value.toLowerCase();
	if (v === "cascade") {
		cursor.next();
		return { rule: "cascade", span: tok.span };
	}
	if (v === "restrict") {
		cursor.next();
		return { rule: "restrict", span: tok.span };
	}
	// `set null` : `set` est keyword, `null` est literal token.
	if (tok.kind === "keyword" && v === "set") {
		cursor.next();
		const nullTok = cursor.peek();
		const isNull =
			nullTok.kind === "null" ||
			(nullTok.kind === "ident" && nullTok.value.toLowerCase() === "null");
		if (!isNull) {
			throw new SnqlError(
				"'set' doit être suivi de 'null' dans une règle de cascade",
				"parse_ddl_ref_expected_null_after_set",
				nullTok.span
			);
		}
		cursor.next();
		return { rule: "set-null", span: nullTok.span };
	}
	throw new SnqlError(
		"règle de cascade attendue : 'cascade', 'restrict' ou 'set null'",
		"parse_ddl_ref_invalid_rule",
		tok.span
	);
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
export function parseAddColumn(cursor: TokenCursor): AddColumnStmt {
	const addTok = cursor.next(); // `add` verb
	cursor.next(); // `column` ident (déjà peeked au dispatch)

	// Nom de la colonne à ajouter — même règle IDENT_REGEX D1 que create table.
	// Surface SQL-familière : pas de `:` séparateur (aligné `ALTER TABLE t ADD
	// COLUMN col TYPE`), contrairement au body `create table { col: type }` qui
	// est un object literal.
	const nameTok = cursor.expect(
		"ident",
		"un nom de colonne après 'add column'"
	);
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
	let ref: FieldRefModifier | undefined;
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
		} else if (nxt.kind === "ident" && v === "ref") {
			ref = parseFieldRefModifier(cursor);
			endSpan = ref.span;
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
		...(ref !== undefined ? { ref } : {}),
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
 * Colonne adressée par `<table>.<colonne>` (ADR-036) — `rename column`,
 * `alter column`. `verb` alimente les messages d'erreur.
 */
function parseColumnPath(
	cursor: TokenCursor,
	verb: string
): { table: Token; column: Token } {
	const table = cursor.expect(
		"ident",
		`'<table>.<colonne>' après '${verb}' (ex. ${verb} agency.phone)`
	);
	if (cursor.peek().kind !== "dot") {
		throw new SnqlError(
			`'${verb}' attend '<table>.<colonne>' (ex. ${verb} agency.phone)`,
			"parse_ddl_column_path_missing_dot",
			cursor.peek().span
		);
	}
	cursor.next(); // dot
	const column = cursor.expect(
		"ident",
		`une colonne après '${table.value}.' (ex. ${verb} agency.phone)`
	);
	return { table, column };
}

/**
 * `rename column <table>.<col> to <nouveau>` (ADR-036 E/1b).
 */
export function parseRenameColumn(cursor: TokenCursor): RenameColumnStmt {
	const renameTok = cursor.next(); // `rename` soft-ident
	cursor.next(); // `column` soft-ident (déjà peeked au dispatch)
	const { table, column } = parseColumnPath(cursor, "rename column");
	if (!peekIdent(cursor, "to")) {
		throw new SnqlError(
			`'rename column ${table.value}.${column.value}' attend 'to <nouveau nom>'`,
			"parse_ddl_rename_column_missing_to",
			cursor.peek().span
		);
	}
	cursor.next();
	const newTok = cursor.expect(
		"ident",
		"le nouveau nom de la colonne après 'to'"
	);
	return {
		operation: "ddl",
		kind: "rename-column",
		target: table.value,
		column: column.value,
		columnSpan: column.span,
		newName: newTok.value,
		newNameSpan: newTok.span,
		span: { start: renameTok.span.start, end: newTok.span.end }
	};
}

/**
 * `alter column <table>.<col> set nullable | set not null | set type <type> |
 * set default <valeur> | drop default` (ADR-036 E/1c, E/1d).
 */
export function parseAlterColumn(cursor: TokenCursor): AlterColumnStmt {
	const alterTok = cursor.next(); // `alter` soft-ident
	cursor.next(); // `column` soft-ident (déjà peeked au dispatch)
	const { table, column } = parseColumnPath(cursor, "alter column");
	const expected =
		"set nullable, set not null, set type <type>, set default <valeur> ou drop default";
	if (peekIdent(cursor, "drop")) {
		cursor.next();
		if (!peekKeyword(cursor, "default")) {
			throw new SnqlError(
				"'drop' attend 'default' dans un alter column",
				"parse_ddl_alter_column_expected_action",
				cursor.peek().span
			);
		}
		const defaultTok = cursor.next();
		return {
			operation: "ddl",
			kind: "alter-column",
			target: table.value,
			column: column.value,
			columnSpan: column.span,
			action: { kind: "drop-default" },
			span: { start: alterTok.span.start, end: defaultTok.span.end }
		};
	}
	if (!peekKeyword(cursor, "set")) {
		throw new SnqlError(
			`'alter column ${table.value}.${column.value}' attend une action : ${expected}`,
			"parse_ddl_alter_column_expected_action",
			cursor.peek().span
		);
	}
	cursor.next();
	const tok = cursor.peek();
	const word = tok.value.toLowerCase();
	let action: AlterColumnAction;
	let end: Span;
	if (tok.kind === "ident" && word === "nullable") {
		cursor.next();
		action = { kind: "set-nullable" };
		end = tok.span;
	} else if (tok.kind === "keyword" && word === "not") {
		cursor.next();
		const nullTok = cursor.peek();
		const isNull =
			nullTok.kind === "null" ||
			(nullTok.kind === "ident" && nullTok.value.toLowerCase() === "null");
		if (!isNull) {
			throw new SnqlError(
				"'set not' doit être suivi de 'null'",
				"parse_ddl_expected_null_after_not",
				nullTok.span
			);
		}
		cursor.next();
		action = { kind: "set-not-null" };
		end = nullTok.span;
	} else if (tok.kind === "keyword" && word === "default") {
		cursor.next();
		const expr = parseExpression(cursor);
		action = { kind: "set-default", expr };
		end = expr.span;
	} else if (tok.kind === "ident" && word === "type") {
		cursor.next();
		const typeTok = cursor.expect(
			"ident",
			"un type SNQL (uuid/string/int/...), alias PG (varchar/jsonb/...) ou nom d'enum"
		);
		action = {
			kind: "set-type",
			type: parseFieldTypeRef(typeTok.value),
			typeSpan: typeTok.span
		};
		end = typeTok.span;
	} else {
		throw new SnqlError(
			`'alter column … set' attend ${expected}`,
			"parse_ddl_alter_column_expected_action",
			tok.span
		);
	}
	return {
		operation: "ddl",
		kind: "alter-column",
		target: table.value,
		column: column.value,
		columnSpan: column.span,
		action,
		span: { start: alterTok.span.start, end: end.end }
	};
}

/**
 * `drop table <name> [if exists]` (DDL/4). Destructive — le frontend applique
 * D7 typing UI gate WriteConfirmBar. PG DROP TABLE RESTRICT (safe vs FK).
 * Mongo dropCollection natif. KV compensation SCAN + DEL (wiring V-next).
 */
export function parseDropTable(cursor: TokenCursor): DropTableStmt {
	const dropTok = cursor.next(); // `drop` soft-ident
	cursor.next(); // `table` keyword (déjà peeked)
	const targetTok = cursor.expect(
		"ident",
		"un nom de table après 'drop table'"
	);

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

export function parseDropColumn(cursor: TokenCursor): DropColumnStmt {
	const dropTok = cursor.next(); // `drop` soft-ident
	cursor.next(); // `column` soft-ident (déjà peeked)
	const colTok = cursor.expect(
		"ident",
		"un nom de colonne après 'drop column'"
	);

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
