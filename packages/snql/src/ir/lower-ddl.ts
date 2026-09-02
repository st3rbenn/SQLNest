/**
 * Lower AST DDL Tier-2 → DDL Plan canonique. Miroir strict de `lowerMutation`
 * pour DML : validations engine-agnostiques ici (D1 identifiers + literal-only
 * defaults + PK reference check), refus par engine (D13 Mongo PK non-id, etc.)
 * remontés au `planner.ts`. Vault : [[ADR-029 — SNQL Langage Unifié Tier-2 DDL]].
 */

import { SnqlError } from "../diagnostics";
import type {
	AddColumnStmt,
	AddEnumMemberStmt,
	AddIndexStmt,
	CreateEnumStmt,
	CreateTableStmt,
	DDLStatement,
	DropColumnStmt,
	DropEnumStmt,
	DropIndexStmt,
	DropRefStmt,
	DropTableStmt,
	Expr
} from "../parser/ast";
import type { SchemaModel, SnqlType } from "../schema/model";
import type {
	AddColumnPlan,
	AddEnumMemberPlan,
	AddIndexPlan,
	CreateEnumPlan,
	CreateTableField,
	CreateTablePlan,
	DdlDefault,
	DDLPlan,
	DropColumnPlan,
	DropEnumPlan,
	DropIndexPlan,
	DropRefPlan,
	DropTablePlan,
	SqlJsonLiteral,
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
	schema?: SchemaModel
): DDLPlan {
	if (statement.kind === "create-table") {
		return lowerCreateTable(statement, schema);
	}
	if (statement.kind === "add-column") {
		return lowerAddColumn(statement, schema);
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
	if (statement.kind === "create-enum") {
		return lowerCreateEnum(statement);
	}
	if (statement.kind === "add-enum-member") {
		return lowerAddEnumMember(statement, schema);
	}
	if (statement.kind === "drop-enum") {
		return lowerDropEnum(statement, schema);
	}
	if (statement.kind === "drop-ref") {
		return lowerDropRef(statement, schema);
	}
	throw new SnqlError(
		`DDL kind '${(statement as { kind: string }).kind}' non supporté au lower`,
		"lower_ddl_unsupported_kind"
	);
}

/**
 * Lower `drop ref` (ADR-031 FK/3) : D1 ident regex sur name + target. Si
 * `schema.refs` disponible, on vérifie que la ref existe SUR la table cible
 * (sauf `if exists` — miroir drop-enum). L'erreur liste les refs de la table
 * pour rendre le nom auto-généré retrouvable sans `raw`. Les relations
 * INFÉRÉES (heuristique naming) vivent dans `schema.relations`, pas `refs` —
 * introuvables ici par construction, ce qui est le comportement voulu (rien
 * à dropper : aucune contrainte déclarée n'existe).
 */
function lowerDropRef(
	stmt: DropRefStmt,
	schema?: SchemaModel
): DropRefPlan {
	assertIdent(stmt.target, "target");
	assertIdent(stmt.name, "ref name");
	if (schema?.refs !== undefined && !stmt.ifExists) {
		const ref = schema.refs.find(
			(r) => r.name === stmt.name && r.fromCollection === stmt.target
		);
		if (ref === undefined) {
			const onTarget = schema.refs
				.filter((r) => r.fromCollection === stmt.target)
				.map((r) => `${r.name} (${r.fromColumn} → ${r.toCollection}.${r.toColumn})`)
				.join(", ");
			throw new SnqlError(
				`Foreign key '${stmt.name}' inconnue sur '${stmt.target}' — refs déclarées : ${onTarget || "(aucune)"}`,
				"lower_ddl_drop_ref_unknown_ref",
				stmt.span
			);
		}
	}
	return {
		op: "ddl",
		kind: "drop-ref",
		target: stmt.target,
		name: stmt.name,
		ifExists: stmt.ifExists ?? false,
		...(stmt.span !== undefined ? { span: stmt.span } : {})
	};
}

/**
 * Lower `add enum member` (ADR-030 Enum/3) : D1 ident regex sur name.
 * Si `schema.enums` disponible, on vérifie que l'enum existe (refus typé si
 * inconnu — même pattern que `resolveFieldType` enum-ref) et on **snapshot
 * silence** si le member est déjà présent (D3 pattern idempotent — pas
 * d'erreur, même sans `if not exists` explicite, aligne le comportement
 * cross-engine PG `ADD VALUE IF NOT EXISTS` natif). Si `schema` absent
 * (analyse offline), on laisse passer — le runtime tranchera à l'exec.
 */
function lowerAddEnumMember(
	stmt: AddEnumMemberStmt,
	schema?: SchemaModel
): AddEnumMemberPlan {
	assertIdent(stmt.name, "enum name");
	if (schema?.enums !== undefined) {
		const enumDef = schema.enums.find((e) => e.name === stmt.name);
		if (enumDef === undefined) {
			const available = schema.enums.map((e) => e.name).join(", ") || "(aucun)";
			throw new SnqlError(
				`Enum '${stmt.name}' inconnu — enums disponibles : ${available}`,
				"lower_ddl_add_enum_member_unknown_enum",
				stmt.span
			);
		}
	}
	return {
		op: "ddl",
		kind: "add-enum-member",
		name: stmt.name,
		member: stmt.member,
		ifNotExists: stmt.ifNotExists ?? false,
		...(stmt.span !== undefined ? { span: stmt.span } : {})
	};
}

/**
 * Lower `drop enum` (ADR-030 Enum/3 D8) : D1 ident regex sur name. Si
 * `schema.enums` disponible, on vérifie que l'enum existe (sauf `if exists`
 * qui rend le miss OK — miroir drop-table). L'assertion RESTRICT vs
 * colonnes utilisatrices est laissée au runtime (PG natif refuse via
 * `2BP01 dependent objects`, Mongo/KV compensent au moment de patcher
 * les validators — nécessite lister les collections utilisatrices).
 */
function lowerDropEnum(
	stmt: DropEnumStmt,
	schema?: SchemaModel
): DropEnumPlan {
	assertIdent(stmt.name, "enum name");
	if (schema?.enums !== undefined && !stmt.ifExists) {
		const enumDef = schema.enums.find((e) => e.name === stmt.name);
		if (enumDef === undefined) {
			const available = schema.enums.map((e) => e.name).join(", ") || "(aucun)";
			throw new SnqlError(
				`Enum '${stmt.name}' inconnu — enums disponibles : ${available}`,
				"lower_ddl_drop_enum_unknown_enum",
				stmt.span
			);
		}
	}
	return {
		op: "ddl",
		kind: "drop-enum",
		name: stmt.name,
		ifExists: stmt.ifExists ?? false,
		cascade: stmt.cascade ?? false,
		...(stmt.span !== undefined ? { span: stmt.span } : {})
	};
}

/**
 * Lower `create enum` (ADR-030 Enum/1) : D1 ident regex sur name + tous les
 * members, refus si doublon (case-sensitive), refus si liste vide.
 */
function lowerCreateEnum(stmt: CreateEnumStmt): CreateEnumPlan {
	assertIdent(stmt.name, "enum name");
	if (stmt.members.length === 0) {
		throw new SnqlError(
			`'create enum ${stmt.name}' attend au moins un member`,
			"lower_ddl_create_enum_empty",
			stmt.span
		);
	}
	const seen = new Set<string>();
	for (const m of stmt.members) {
		if (seen.has(m)) {
			throw new SnqlError(
				`Member '${m}' dupliqué dans 'create enum ${stmt.name}'`,
				"lower_ddl_enum_member_duplicate",
				stmt.span
			);
		}
		seen.add(m);
	}
	return {
		op: "ddl",
		kind: "create-enum",
		name: stmt.name,
		members: stmt.members,
		ifNotExists: stmt.ifNotExists ?? false,
		...(stmt.span !== undefined ? { span: stmt.span } : {})
	};
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

function lowerAddColumn(
	stmt: AddColumnStmt,
	schema?: SchemaModel
): AddColumnPlan {
	assertIdent(stmt.target, "target");
	assertIdent(stmt.column.name, "field");
	const resolved = resolveFieldType(
		stmt.column.type,
		stmt.column.name,
		schema,
		stmt.column.typeSpan
	);
	const nullable = stmt.column.nullable ?? false;
	const unique = stmt.column.unique ?? false;
	const ref =
		stmt.column.ref !== undefined
			? resolveFieldRef(
					stmt.column.ref,
					stmt.target,
					stmt.column.name,
					resolved.type,
					nullable,
					schema,
					[{ name: stmt.column.name, type: resolved.type }]
				)
			: undefined;
	const base: CreateTableField = {
		name: stmt.column.name,
		type: resolved.type,
		nullable,
		unique,
		...(ref !== undefined ? { ref } : {}),
		...(resolved.enumTypeName !== undefined
			? { enumTypeName: resolved.enumTypeName }
			: {}),
		...(resolved.enumMembers !== undefined
			? { enumMembers: resolved.enumMembers }
			: {}),
		...(stmt.column.span !== undefined ? { span: stmt.column.span } : {})
	};
	const column: CreateTableField =
		stmt.column.defaultExpr !== undefined
			? {
					...base,
					defaultValue: lowerDefault(
						stmt.column.defaultExpr,
						stmt.column.name,
						resolved.type
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

function lowerCreateTable(
	stmt: CreateTableStmt,
	schema?: SchemaModel
): CreateTablePlan {
	assertIdent(stmt.target, "target");
	if (stmt.fields.length === 0) {
		throw new SnqlError(
			"'create table' attend au moins un field",
			"lower_ddl_empty_fields",
			stmt.span
		);
	}
	// Pass 1 : résout les types (nécessaire avant les refs pour que le self-ref
	// voie les types de toutes les colonnes déclarées).
	const resolvedFields = stmt.fields.map((f) => {
		assertIdent(f.name, "field");
		const resolved = resolveFieldType(f.type, f.name, schema, f.typeSpan);
		return { f, type: resolved.type, resolved, nullable: f.nullable ?? false };
	});
	const currentFieldTypes = resolvedFields.map((r) => ({
		name: r.f.name,
		type: r.type
	}));
	// Pass 2 : construit les CreateTableField + attache defaults + refs.
	const fields: CreateTableField[] = resolvedFields.map(
		({ f, type, resolved, nullable }) => {
			const unique = f.unique ?? false;
			const ref =
				f.ref !== undefined
					? resolveFieldRef(
							f.ref,
							stmt.target,
							f.name,
							type,
							nullable,
							schema,
							currentFieldTypes
						)
					: undefined;
			const base: CreateTableField = {
				name: f.name,
				type,
				nullable,
				unique,
				...(resolved.enumTypeName !== undefined
					? { enumTypeName: resolved.enumTypeName }
					: {}),
				...(resolved.enumMembers !== undefined
					? { enumMembers: resolved.enumMembers }
					: {}),
				...(ref !== undefined ? { ref } : {}),
				...(f.span !== undefined ? { span: f.span } : {})
			};
			if (f.defaultExpr === undefined) return base;
			const value = lowerDefault(f.defaultExpr, f.name, type);
			return { ...base, defaultValue: value };
		}
	);
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

/**
 * Nom auto-généré d'une FK (ADR-031 D4). Pattern `fk_<table>_<col>_<target>`,
 * tronqué à 63 chars (PG NAMEDATALEN + WiredTiger). Override via `as`.
 */
function generateRefName(
	fromCollection: string,
	fromColumn: string,
	targetCollection: string
): string {
	const full = `fk_${fromCollection}_${fromColumn}_${targetCollection}`;
	return full.length <= 63 ? full : full.slice(0, 63);
}

/**
 * Résout + valide un modifier `ref t.c [on delete ...]` (ADR-031 FK/1).
 *  - `self` cible → normalisé sur la table courante (self-reference D3).
 *  - Si `schema` fourni : la collection cible doit exister (sauf self-ref sur
 *    la table en cours de création, validée contre `currentFields`), la
 *    colonne cible doit exister, et le type doit être compatible (léger : même
 *    SnqlType, ou les deux entiers-like uuid/int/bigint).
 *  - `on delete set null` exige que la colonne portante soit nullable.
 *  - Défaut D2 : `restrict` sur delete ET update.
 */
function resolveFieldRef(
	mod: import("../parser/ast").FieldRefModifier,
	fromCollection: string,
	fromColumn: string,
	fromType: SnqlType,
	fromNullable: boolean,
	schema: SchemaModel | undefined,
	currentFields: readonly { name: string; type: SnqlType }[]
): import("./plan").FieldRefPlan {
	const targetCollection =
		mod.targetCollection === "self" ? fromCollection : mod.targetCollection;
	assertIdent(targetCollection, "target");
	assertIdent(mod.targetColumn, "field");
	if (mod.name !== undefined) assertIdent(mod.name, "field");

	const onDelete = mod.onDelete ?? "restrict";
	const onUpdate = mod.onUpdate ?? "restrict";

	if (onDelete === "set-null" && !fromNullable) {
		throw new SnqlError(
			`'ref ${targetCollection}.${mod.targetColumn} on delete set null' exige que '${fromColumn}' soit nullable`,
			"lower_ddl_ref_set_null_not_nullable",
			mod.span
		);
	}

	if (schema !== undefined) {
		const isSelf = targetCollection === fromCollection;
		let targetType: SnqlType | undefined;
		if (isSelf) {
			const targetField = currentFields.find((f) => f.name === mod.targetColumn);
			if (targetField === undefined) {
				throw new SnqlError(
					`'ref self.${mod.targetColumn}' : la colonne '${mod.targetColumn}' n'est pas déclarée dans '${fromCollection}'`,
					"lower_ddl_ref_unknown_target_column",
					mod.span
				);
			}
			targetType = targetField.type;
		} else {
			const targetColl = schema.collections.find(
				(c) => c.name === targetCollection
			);
			if (targetColl === undefined) {
				const available =
					schema.collections.map((c) => c.name).join(", ") || "(aucune)";
				throw new SnqlError(
					`'ref ${targetCollection}.${mod.targetColumn}' : table cible '${targetCollection}' inconnue — tables : ${available}`,
					"lower_ddl_ref_unknown_target_collection",
					mod.span
				);
			}
			const targetCol = targetColl.fields.find(
				(f) => f.name === mod.targetColumn
			);
			if (targetCol === undefined) {
				const available =
					targetColl.fields.map((f) => f.name).join(", ") || "(aucune)";
				throw new SnqlError(
					`'ref ${targetCollection}.${mod.targetColumn}' : colonne '${mod.targetColumn}' inconnue dans '${targetCollection}' — colonnes : ${available}`,
					"lower_ddl_ref_unknown_target_column",
					mod.span
				);
			}
			targetType = targetCol.type;
		}
		if (targetType !== undefined && !refTypesCompatible(fromType, targetType)) {
			throw new SnqlError(
				`'ref ${targetCollection}.${mod.targetColumn}' : type '${fromType}' de '${fromColumn}' incompatible avec '${targetType}' de la cible`,
				"lower_ddl_ref_type_mismatch",
				mod.span
			);
		}
	}

	return {
		name:
			mod.name ??
			generateRefName(fromCollection, fromColumn, targetCollection),
		fromColumn,
		targetCollection,
		targetColumn: mod.targetColumn,
		onDelete,
		onUpdate
	};
}

/**
 * Compatibilité de type FK (ADR-031, léger) : identiques, ou tous deux dans la
 * famille entière-like (uuid/int/bigint) — une FK uuid→uuid ou int→bigint est
 * courante. `unknown` (Mongo inféré) passe (best-effort). Refuse les mismatches
 * flagrants (string→int) tôt.
 */
function refTypesCompatible(a: SnqlType, b: SnqlType): boolean {
	if (a === b) return true;
	if (a === "unknown" || b === "unknown") return true;
	const intLike = new Set<SnqlType>(["uuid", "int", "bigint"]);
	return intLike.has(a) && intLike.has(b);
}

/**
 * Résout un `DDLFieldTypeRef` (parser output) vers le shape enrichi du plan.
 * Builtin → passe-plat SnqlType. Enum-ref → lookup `schema.enums[name]` :
 * trouvé → SnqlType `enum` + snapshot enumTypeName + enumMembers. Absent →
 * refus typé avec liste des enums en scope (aide user).
 */
function resolveFieldType(
	ref: import("../parser/ast").DDLFieldTypeRef,
	fieldName: string,
	schema: SchemaModel | undefined,
	typeSpan: import("../lexer/token").Span
): {
	type: SnqlType;
	enumTypeName?: string;
	enumMembers?: readonly string[];
} {
	if (ref.kind === "builtin") return { type: ref.type };
	assertIdent(ref.name, "enum name");
	const enumDef = schema?.enums?.find((e) => e.name === ref.name);
	if (enumDef === undefined) {
		const available = schema?.enums?.map((e) => e.name).join(", ") ?? "(aucun)";
		throw new SnqlError(
			`Type '${ref.name}' du field '${fieldName}' inconnu — pas un builtin SNQL et aucun enum '${ref.name}' n'existe dans le schema. Enums disponibles : ${available}`,
			"lower_ddl_unknown_type",
			typeSpan
		);
	}
	return {
		type: "enum",
		enumTypeName: enumDef.name,
		enumMembers: enumDef.members
	};
}

function assertIdent(
	name: string,
	kind: "target" | "field" | "enum name" | "ref name"
): void {
	if (!IDENT_REGEX.test(name)) {
		throw new SnqlError(
			`'${name}' n'est pas un identifiant DDL valide (${kind}) — alphanumeric + underscore uniquement, doit commencer par une lettre ou '_', 63 chars max (limite WiredTiger + PG NAMEDATALEN)`,
			"lower_ddl_invalid_identifier"
		);
	}
}

// Literals only : le codegen bind une `DdlDefault`, pas une `PlanExpr`.
// Refuse les calls/refs qui masqueraient des divergences cross-engine
// (`now()` PG vs `$currentDate` Mongo vs rien KV). Cas particulier : un
// object/array literal est admis SEULEMENT sur `type: json` (PG `::jsonb`,
// Mongo/KV natif au backfill) — récurse en profondeur pour interdire les
// call/field imbriqués.
function lowerDefault(expr: Expr, fieldName: string, type: SnqlType): DdlDefault {
	if (expr.type === "object" || expr.type === "array") {
		if (type !== "json") {
			throw new SnqlError(
				`'default' de '${fieldName}' (type ${type}) doit être un littéral scalaire — l'object/array literal n'est admis que sur 'type: json'`,
				"lower_ddl_default_compound_wrong_type",
				expr.span
			);
		}
		return jsonLiteralFromExpr(expr, fieldName);
	}
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

// Sérialise récursivement un object/array literal en valeur JSON. Refuse tout
// noeud non-literal — `default { foo: now() }` ou `default { foo: t.bar }`
// remontent l'erreur au field d'origine (pas au fieldName imbriqué anonyme).
function jsonLiteralFromExpr(expr: Expr, fieldName: string): SqlJsonLiteral {
	const parsed = jsonValueFromExpr(expr, fieldName);
	return { kind: "json", raw: JSON.stringify(parsed), parsed };
}

function jsonValueFromExpr(expr: Expr, fieldName: string): unknown {
	if (expr.type === "object") {
		const out: Record<string, unknown> = {};
		for (const entry of expr.entries) {
			out[entry.key] = jsonValueFromExpr(entry.value, fieldName);
		}
		return out;
	}
	if (expr.type === "array") {
		return expr.items.map((item) => jsonValueFromExpr(item, fieldName));
	}
	if (expr.type === "literal") {
		const v = expr.value;
		switch (v.kind) {
			case "string":
				return v.value;
			case "number":
				return Number(v.raw);
			case "boolean":
				return v.value;
			case "null":
				return null;
		}
	}
	throw new SnqlError(
		`'default' de '${fieldName}' (type json) : littéral compound admis, mais un noeud '${expr.type}' n'est pas un littéral`,
		"lower_ddl_default_json_non_literal",
		expr.span
	);
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
