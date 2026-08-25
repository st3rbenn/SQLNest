/**
 * Lower AST DDL Tier-2 → DDL Plan canonique. Miroir strict de `lowerMutation`
 * pour DML : validations engine-agnostiques ici (D1 identifiers + literal-only
 * defaults + PK reference check), refus par engine (D13 Mongo PK non-id, etc.)
 * remontés au `planner.ts`. Vault : [[ADR-029 — SNQL Langage Unifié Tier-2 DDL]].
 */

import { SnqlError } from "../diagnostics";
import type { CreateTableStmt, DDLStatement, Expr } from "../parser/ast";
import type { SchemaModel, SnqlType } from "../schema/model";
import type { CreateTableField, CreateTablePlan, DDLPlan, SqlValue } from "./plan";

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
	throw new SnqlError(
		`DDL kind '${(statement as { kind: string }).kind}' non supporté au lower`,
		"lower_ddl_unsupported_kind"
	);
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

/**
 * Un `default <val>` doit être un littéral scalaire — pas un call, pas un ref
 * de field, pas d'arith. Motivation triple :
 *  1. Sémantique cross-engine : PG accepte `DEFAULT now()`, Mongo `$currentDate`,
 *     KV rien — un default non-literal fuirait des divergences opaques. On
 *     tranche : DDL/1 = literals only (v-next dédié pour les defaults fn).
 *  2. Safety : refus tôt d'un `default $where` (déjà bloqué au parser par la
 *     regex ident, mais la string literal `"$where"` reste inerte ici — géré
 *     au codegen Mongo via échappement $jsonSchema).
 *  3. Simplicité : le codegen bind un `SqlValue`, pas une `PlanExpr`.
 */
function lowerDefault(expr: Expr, fieldName: string, type: SnqlType): SqlValue {
	if (expr.type !== "literal") {
		throw new SnqlError(
			`'default' de '${fieldName}' doit être un littéral scalaire (string, number, bool, null) — pas de call/field/expr (DDL/1 restreint aux literals ; les defaults dynamiques arrivent )`,
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
