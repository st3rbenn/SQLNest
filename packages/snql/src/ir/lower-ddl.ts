/**
 * Lower AST DDL Tier-2 → DDL Plan canonique. Miroir strict de `lowerMutation`
 * pour DML : validations engine-agnostiques ici (D1 identifiers + literal-only
 * defaults + PK reference check), refus par engine (D13 Mongo PK non-id, etc.)
 * remontés au `planner.ts`. Vault : [[ADR-029 — SNQL Langage Unifié Tier-2 DDL]].
 */

import { SnqlError } from "../diagnostics";
import type {
	AddColumnStmt,
	AddIndexStmt,
	CreateTableStmt,
	DDLStatement,
	DropColumnStmt,
	DropIndexStmt,
	DropTableStmt,
	Expr
} from "../parser/ast";
import type { SchemaModel, SnqlType } from "../schema/model";
import type {
	AddColumnPlan,
	AddIndexPlan,
	CreateTableField,
	CreateTablePlan,
	DDLPlan,
	DropColumnPlan,
	DropIndexPlan,
	DropTablePlan,
	SqlValue
} from "./plan";

/**
 * Longueur max = 63 chars (WiredTiger + PG NAMEDATALEN aligné). D1 ADR-029.
 * Le parser peut avoir déjà accepté des identifiants au sens tokeniser mais
 * le lower serre la vis pour interdire tout ident hors du sous-ensemble
 * ASCII-portable cross-engine.
 */
const IDENT_REGEX = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

export function lowerDDL(
	statement: DDLStatement,
	_schema?: SchemaModel
): DDLPlan {
	if (statement.kind === "create-table") {
		return lowerCreateTable(statement);
	}
	if (statement.kind === "add-column") {
		return lowerAddColumn(statement);
	}
	if (statement.kind === "add-index" || statement.kind === "add-unique-index") {
		return lowerAddIndex(statement);
	}
	if (statement.kind === "drop-index") {
		return lowerDropIndex(statement);
	}
	if (statement.kind === "drop-table") {
		return lowerDropTable(statement);
	}
	if (statement.kind === "drop-column") {
		return lowerDropColumn(statement);
	}
	throw new SnqlError(
		`DDL kind '${(statement as { kind: string }).kind}' non supporté au lower`,
		"lower_ddl_unsupported_kind"
	);
}

function lowerDropTable(stmt: DropTableStmt): DropTablePlan {
	assertIdent(stmt.target, "target");
	return {
		op: "ddl",
		kind: "drop-table",
		target: stmt.target,
		ifExists: stmt.ifExists ?? false,
		...(stmt.span !== undefined ? { span: stmt.span } : {})
	};
}

function lowerDropColumn(stmt: DropColumnStmt): DropColumnPlan {
	assertIdent(stmt.target, "target");
	assertIdent(stmt.column, "field");
	return {
		op: "ddl",
		kind: "drop-column",
		target: stmt.target,
		column: stmt.column,
		ifExists: stmt.ifExists ?? false,
		...(stmt.span !== undefined ? { span: stmt.span } : {})
	};
}

/**
 * Nom auto-généré pour un index (DDL/3). Pattern figé cross-engine :
 *  - non-unique : `idx_<table>_<f1_f2_...>` (SQL-familier).
 *  - unique : `unique_<table>_<f1_f2_...>` (aligné convention Mongo `unique_<f>`
 *    de DDL/1.6 primary key compound).
 * Le nom respecte IDENT_REGEX (chaque field passe déjà D1 au parser + assertIdent).
 * Longueur cap : 63 chars WiredTiger — un index sur 5+ fields long-named peut
 * dépasser. On tronque hard à 63 pour éviter un fail Mongo tardif ; l'user peut
 * override en passant `name` explicite (v-next parser).
 */
function generateIndexName(
	target: string,
	fields: readonly string[],
	unique: boolean
): string {
	const prefix = unique ? "unique" : "idx";
	const joined = fields.join("_");
	const full = `${prefix}_${target}_${joined}`;
	return full.length <= 63 ? full : full.slice(0, 63);
}

function lowerAddIndex(stmt: AddIndexStmt): AddIndexPlan {
	assertIdent(stmt.target, "target");
	if (stmt.fields.length === 0) {
		throw new SnqlError(
			"'add index' attend au moins un field",
			"lower_ddl_index_empty_fields",
			stmt.span
		);
	}
	for (const f of stmt.fields) assertIdent(f, "field");
	// Dédup — un index sur `(email, email)` est un usage error clair.
	const seen = new Set<string>();
	for (const f of stmt.fields) {
		if (seen.has(f)) {
			throw new SnqlError(
				`'add index' liste '${f}' plusieurs fois`,
				"lower_ddl_index_duplicate_field",
				stmt.span
			);
		}
		seen.add(f);
	}
	const unique = stmt.kind === "add-unique-index";
	const name = stmt.name ?? generateIndexName(stmt.target, stmt.fields, unique);
	return {
		op: "ddl",
		kind: stmt.kind,
		target: stmt.target,
		fields: stmt.fields,
		name,
		ifNotExists: stmt.ifNotExists ?? false,
		...(stmt.span !== undefined ? { span: stmt.span } : {})
	};
}

function lowerDropIndex(stmt: DropIndexStmt): DropIndexPlan {
	assertIdent(stmt.target, "target");
	assertIdent(stmt.name, "field");
	return {
		op: "ddl",
		kind: "drop-index",
		target: stmt.target,
		name: stmt.name,
		ifExists: stmt.ifExists ?? false,
		...(stmt.span !== undefined ? { span: stmt.span } : {})
	};
}

function lowerAddColumn(stmt: AddColumnStmt): AddColumnPlan {
	assertIdent(stmt.target, "target");
	assertIdent(stmt.column.name, "field");
	const nullable = stmt.column.nullable ?? false;
	const unique = stmt.column.unique ?? false;
	const base: CreateTableField = {
		name: stmt.column.name,
		type: stmt.column.type,
		nullable,
		unique,
		...(stmt.column.span !== undefined ? { span: stmt.column.span } : {})
	};
	const column: CreateTableField =
		stmt.column.defaultExpr !== undefined
			? {
					...base,
					defaultValue: lowerDefault(
						stmt.column.defaultExpr,
						stmt.column.name,
						stmt.column.type
					)
				}
			: base;
	return {
		op: "ddl",
		kind: "add-column",
		target: stmt.target,
		ifNotExists: stmt.ifNotExists ?? false,
		column,
		...(stmt.span !== undefined ? { span: stmt.span } : {})
	};
}

function lowerCreateTable(stmt: CreateTableStmt): CreateTablePlan {
	assertIdent(stmt.target, "target");
	if (stmt.fields.length === 0) {
		throw new SnqlError(
			"'create table' attend au moins un field",
			"lower_ddl_empty_fields",
			stmt.span
		);
	}
	const fields: CreateTableField[] = stmt.fields.map((f) => {
		assertIdent(f.name, "field");
		const nullable = f.nullable ?? false;
		const unique = f.unique ?? false;
		const base: CreateTableField = {
			name: f.name,
			type: f.type,
			nullable,
			unique,
			...(f.span !== undefined ? { span: f.span } : {})
		};
		if (f.defaultExpr === undefined) return base;
		const value = lowerDefault(f.defaultExpr, f.name, f.type);
		return { ...base, defaultValue: value };
	});
	if (stmt.primaryKey !== undefined) {
		assertPrimaryKey(stmt.primaryKey, fields, stmt.span);
	}
	const plan: CreateTablePlan = {
		op: "ddl",
		kind: "create-table",
		target: stmt.target,
		ifNotExists: stmt.ifNotExists ?? false,
		fields,
		...(stmt.primaryKey !== undefined ? { primaryKey: stmt.primaryKey } : {}),
		...(stmt.span !== undefined ? { span: stmt.span } : {})
	};
	return plan;
}

function assertIdent(name: string, kind: "target" | "field"): void {
	if (!IDENT_REGEX.test(name)) {
		throw new SnqlError(
			`'${name}' n'est pas un identifiant DDL valide (${kind}) — alphanumeric + underscore uniquement, doit commencer par une lettre ou '_', 63 chars max (limite WiredTiger + PG NAMEDATALEN)`,
			"lower_ddl_invalid_identifier"
		);
	}
}

// Literals only : le codegen bind un `SqlValue`, pas une `PlanExpr`. Refuse
// aussi tôt les calls/refs qui masqueraient des divergences cross-engine
// (`now()` PG vs `$currentDate` Mongo vs rien KV).
function lowerDefault(expr: Expr, fieldName: string, type: SnqlType): SqlValue {
	if (expr.type !== "literal") {
		throw new SnqlError(
			`'default' de '${fieldName}' doit être un littéral scalaire (string, number, bool, null)`,
			"lower_ddl_default_not_literal",
			expr.span
		);
	}
	const value = expr.value;
	switch (value.kind) {
		case "string":
			return value.value;
		case "number":
			return numberFromLiteralRaw(value.raw, fieldName, type, expr);
		case "boolean":
			return value.value;
		case "null":
			return null;
	}
}

/**
 * Convertit un raw numeric literal en `SqlValue` typé.
 *
 * bigint / decimal restent en shape spéciale (D1 : préserver precision > 2^53
 * pour les colonnes bigint/numeric PG). `int` / `float` sont ramenés à `number`
 * (JS safe range assumé pour un default constant écrit à la main).
 */
function numberFromLiteralRaw(
	raw: string,
	fieldName: string,
	type: SnqlType,
	expr: Expr
): SqlValue {
	if (type === "bigint") {
		try {
			return BigInt(raw);
		} catch {
			throw new SnqlError(
				`'default' de '${fieldName}' (type bigint) : '${raw}' n'est pas un entier valide`,
				"lower_ddl_default_bigint_invalid",
				expr.span
			);
		}
	}
	if (type === "decimal") {
		return { kind: "decimal", raw };
	}
	const n = Number(raw);
	if (Number.isNaN(n)) {
		throw new SnqlError(
			`'default' de '${fieldName}' : '${raw}' n'est pas un nombre valide`,
			"lower_ddl_default_number_invalid",
			expr.span
		);
	}
	return n;
}

function assertPrimaryKey(
	pk: readonly string[],
	fields: readonly CreateTableField[],
	span: import("../lexer/token").Span
): void {
	if (pk.length === 0) {
		throw new SnqlError(
			"'primary key' attend au moins un field",
			"lower_ddl_pk_empty",
			span
		);
	}
	const known = new Set(fields.map((f) => f.name));
	const seen = new Set<string>();
	for (const col of pk) {
		if (!known.has(col)) {
			throw new SnqlError(
				`'primary key' réfère à '${col}' qui n'est pas déclaré dans le body`,
				"lower_ddl_pk_unknown_field",
				span
			);
		}
		if (seen.has(col)) {
			throw new SnqlError(
				`'primary key' liste '${col}' plusieurs fois`,
				"lower_ddl_pk_duplicate",
				span
			);
		}
		seen.add(col);
	}
}
