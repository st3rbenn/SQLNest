/**
 * Patch de `schema.prisma` pour une opération DDL (ADR-037 D6). Seules les
 * lignes des blocs touchés changent ; `prisma format` réaligne ensuite. Le
 * modèle décrit le DDL du profil `prisma` de SNQL : types natifs, défauts,
 * actions, noms d'objets (`map:` seulement hors convention). Ce que la base ne
 * dit pas (modèle, champs de relation, nom de relation) vient de `names`,
 * sinon des conventions du fichier.
 */

import {
	type AddIndexPlan,
	type AlterColumnPlan,
	type AlterColumnPlanAction,
	type CreateEnumPlan,
	type CreateTableField,
	type CreateTablePlan,
	type DDLPlan,
	type DdlDefault,
	type DropEnumPlan,
	type FieldRefPlan,
	prismaConventionalName,
	type RenameColumnPlan,
	type SchemaModel
} from "@sqlnest/snql";
import {
	argument,
	fieldList,
	type PrismaArgument,
	type PrismaAttribute,
	parseArguments,
	parseAttributes,
	quote,
	renameInFieldList,
	renderArguments,
	renderAttribute,
	renderAttributes,
	stringValue,
	withArgument
} from "./attributes";
import { SchemaEditor } from "./edit";
import {
	backFieldName,
	type FileConventions,
	fieldName,
	fieldNames,
	fileConventions,
	modelName,
	type RelationNaming,
	relationFieldName,
	relationName,
	relationQualifier,
	unique
} from "./naming";
import {
	backFieldOf,
	isModelType,
	models,
	owningRelations,
	type RelationField,
	relationFields,
	relationsBetween
} from "./relations";
import {
	blockAttributes,
	columnOf,
	findBlock,
	modelFields,
	modelOfTable,
	type PrismaBlock,
	type PrismaField,
	type PrismaSchema,
	parseField,
	providerOf,
	tableOf
} from "./schema-file";
import {
	defaultActions,
	engineOf,
	type PrismaProvider,
	prismaAction,
	prismaDefaultValue,
	prismaScalar,
	referentialArguments
} from "./types";

export interface PrismaRelationNames {
	/** Champ de relation, dans le modèle qui porte la FK. */
	readonly field?: string;
	/** Champ retour, dans le modèle cible. */
	readonly back?: string;
	/** `@relation("…")`, posé quand deux relations relient les mêmes modèles. */
	readonly name?: string;
}

export interface PrismaPatchNames {
	/** Modèle d'une nouvelle table. */
	readonly model?: string;
	/** Par FK, `table.colonne` : la relation créée, ou une relation existante à nommer. */
	readonly relations?: Readonly<Record<string, PrismaRelationNames>>;
}

export interface PrismaPatchContext {
	/** Schéma de la base avant le changement. */
	readonly schema: SchemaModel;
	readonly names?: PrismaPatchNames;
}

export interface PrismaPatch {
	readonly text: string;
	/** Noms retenus, fournis ou déduits : l'aperçu les montre. */
	readonly names: PrismaPatchNames;
}

/** Le modèle ne correspond pas à la base : table ou colonne sans modèle, nom pris. */
export class PrismaPatchError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PrismaPatchError";
	}
}

interface Patcher {
	readonly editor: SchemaEditor;
	readonly provider: PrismaProvider;
	readonly engine: "postgres" | "mssql";
	readonly conventions: FileConventions;
	readonly indent: string;
	readonly db: SchemaModel;
	readonly requested: PrismaPatchNames;
	readonly relations: Record<string, PrismaRelationNames>;
	model?: string;
}

/** Fournisseur Prisma de chaque moteur dont Prisma écrit les migrations. */
const PROVIDERS: Readonly<Record<string, PrismaProvider>> = {
	postgres: "postgresql",
	mssql: "sqlserver"
};
const LEADING_SPACE_RE = /^\s*/;
const WHITESPACE_RE = /\s/;
const INDEX_ATTRIBUTES = new Set(["@@id", "@@unique", "@@index"]);
const ATTRIBUTE_ORDER = [
	"@id",
	"@unique",
	"@default",
	"@updatedAt",
	"@map",
	"@db.",
	"@relation",
	"@ignore"
];
/** Table des enums de SNQL sous SQL Server (codegen MSSQL). */
const SQLSERVER_ENUMS_TABLE = "_snql_enums";
/** Types que Prisma écrit entre guillemets dans `@default(…)`. */
const QUOTED_DEFAULT_TYPES = new Set(["String", "Json", "DateTime", "Bytes"]);
/** Texte `(max)` rétréci par SNQL quand il entre dans un index SQL Server. */
const SQLSERVER_INDEXABLE: Readonly<Record<string, string>> = {
	"@db.nvarchar(max)": "@db.NVarChar(450)",
	"@db.ntext": "@db.NVarChar(450)",
	"@db.varchar(max)": "@db.VarChar(900)",
	"@db.text": "@db.VarChar(900)",
	"@db.varbinary(max)": "@db.VarBinary(900)",
	"@db.image": "@db.VarBinary(900)"
};

export function patchPrismaSchema(
	text: string,
	plan: DDLPlan,
	context: PrismaPatchContext
): PrismaPatch {
	const editor = new SchemaEditor(text);
	const schema = editor.schema;
	const provider = PROVIDERS[context.schema.engine];
	if (provider === undefined || providerOf(schema) !== provider) {
		throw new PrismaPatchError(
			`schema.prisma décrit une base « ${providerOf(schema) ?? "?"} », la connexion est ${context.schema.engine}`
		);
	}
	const p: Patcher = {
		editor,
		provider,
		engine: engineOf(provider),
		conventions: fileConventions(schema),
		indent: editor.indent,
		db: context.schema,
		requested: context.names ?? {},
		relations: {}
	};
	apply(p, plan);
	return {
		text: editor.text(),
		names: {
			...(p.model !== undefined ? { model: p.model } : {}),
			...(Object.keys(p.relations).length > 0 ? { relations: p.relations } : {})
		}
	};
}

function apply(p: Patcher, plan: DDLPlan): void {
	switch (plan.kind) {
		case "create-table":
			createTable(p, plan);
			break;
		case "add-column":
			addColumn(p, plan.target, plan.column);
			break;
		case "drop-column":
			dropColumn(p, plan.target, plan.column);
			break;
		case "drop-table":
			dropTable(p, plan.target);
			break;
		case "rename-column":
			renameColumn(p, plan);
			break;
		case "alter-column":
			alterColumn(p, plan);
			break;
		case "add-index":
		case "add-unique-index":
			addIndex(p, plan);
			break;
		case "drop-index":
			dropIndex(p, plan.target, plan.name);
			break;
		case "add-ref":
			addRelation(p, plan.target, plan.ref);
			alignForeignKeyType(p, plan.target, plan.ref);
			break;
		case "drop-ref":
			dropRelation(p, plan.target, plan.name);
			break;
		case "create-enum":
			createEnum(p, plan);
			break;
		case "add-enum-member":
			addEnumMember(p, plan.name, plan.member);
			break;
		case "drop-enum":
			dropEnum(p, plan);
			break;
	}
}

// ─── Tables et colonnes ──────────────────────────────────────────────────

function createTable(p: Patcher, plan: CreateTablePlan): void {
	const schema = p.editor.schema;
	if (modelOfTable(schema, plan.target) !== undefined) return;
	const taken = new Set(schema.blocks.map((b) => b.name));
	const requested = p.requested.model;
	if (requested !== undefined && taken.has(requested)) {
		throw new PrismaPatchError(
			`« ${requested} » est déjà un bloc de schema.prisma`
		);
	}
	const model =
		requested ?? unique(modelName(plan.target, p.conventions), taken);
	p.model = model;
	const primaryKey = plan.primaryKey ?? [];
	const names = new Map<string, string>();
	for (const f of plan.fields) {
		names.set(
			f.name,
			unique(fieldName(f.name, p.conventions), new Set(names.values()))
		);
	}
	const nameOf = (column: string): string => names.get(column) ?? column;
	const soleKey = primaryKey.length === 1 ? primaryKey[0] : undefined;
	const lines = [
		`model ${model} {`,
		...plan.fields.map((f) =>
			scalarField(p, {
				table: plan.target,
				field: f,
				name: nameOf(f.name),
				...(f.name === soleKey
					? { primaryKey: { name: plan.primaryKeyName } }
					: {}),
				key: primaryKey.includes(f.name) || f.unique
			})
		)
	];
	const attributes: string[] = [];
	if (primaryKey.length > 1) {
		attributes.push(
			renderAttribute(
				attributeWith(
					"@@id",
					[{ value: `[${primaryKey.map(nameOf).join(", ")}]` }],
					mapArgument(
						plan.primaryKeyName,
						conventional(p, plan.target, [], "pkey")
					)
				)
			)
		);
	}
	if (model !== plan.target) attributes.push(`@@map(${quote(plan.target)})`);
	// Sans clé ni unicité, Prisma Client ne peut pas servir la table.
	if (primaryKey.length === 0 && !plan.fields.some((f) => f.unique)) {
		attributes.push("@@ignore");
	}
	if (attributes.length > 0) {
		lines.push("", ...attributes.map((a) => p.indent + a));
	}
	lines.push("}");
	p.editor.insertBlock(lines, models(schema).at(-1) ?? schema.blocks.at(-1));
	for (const f of plan.fields) {
		if (f.ref !== undefined) {
			addRelation(p, plan.target, f.ref, f.unique || f.name === soleKey);
		}
	}
	// Une FK vers une colonne de la même table, elle-même FK, attend son type.
	const aligned = new Set<string>();
	const align = (f: CreateTableField, seen: ReadonlySet<string>): void => {
		const ref = f.ref;
		if (ref === undefined || aligned.has(f.name)) return;
		const target = plan.fields.find(
			(t) =>
				ref.targetCollection === plan.target &&
				t.name === ref.targetColumn &&
				!seen.has(t.name)
		);
		if (target !== undefined) align(target, new Set([...seen, f.name]));
		alignForeignKeyType(p, plan.target, ref);
		aligned.add(f.name);
	};
	for (const f of plan.fields) align(f, new Set());
}

function addColumn(p: Patcher, table: string, column: CreateTableField): void {
	const schema = p.editor.schema;
	const model = requireModel(schema, table);
	if (scalarOf(schema, model, column.name) !== undefined) return;
	const name = unique(
		fieldName(column.name, p.conventions),
		fieldNames(schema, model)
	);
	const fields = modelFields(schema, model);
	const scalars = fields.filter((f) => !isModelType(schema, f.type));
	const after = scalars.at(-1) ?? fields.at(-1);
	p.editor.insert(
		(after?.line ?? model.start) + 1,
		[scalarField(p, { table, field: column, name, key: column.unique })],
		model
	);
	if (column.ref !== undefined) {
		addRelation(p, table, column.ref, column.unique);
		alignForeignKeyType(p, table, column.ref);
	}
}

function dropColumn(p: Patcher, table: string, column: string): void {
	const schema = p.editor.schema;
	const model = modelOfTable(schema, table);
	if (model === undefined) return;
	const field = scalarOf(schema, model, column);
	if (field === undefined) return;
	// FK de la colonne, et FK qui la référencent : leurs contraintes tombent avec elle.
	const relations = owningRelations(schema).filter(
		(r) =>
			(r.model.name === model.name && r.fields.includes(field.name)) ||
			(r.field.type === model.name && r.references.includes(field.name))
	);
	const lines = [field.line, ...relationLines(schema, relations)];
	for (const a of blockAttributes(schema, model)) {
		if (indexFields(a.text)?.includes(field.name) === true) lines.push(a.line);
	}
	p.editor.remove(lines, [model, ...relationBlocks(schema, relations)]);
}

function dropTable(p: Patcher, table: string): void {
	const schema = p.editor.schema;
	const model = modelOfTable(schema, table);
	if (model === undefined) return;
	const lines: number[] = [];
	const blocks: PrismaBlock[] = [];
	for (const other of models(schema)) {
		if (other.name === model.name) continue;
		for (const f of modelFields(schema, other)) {
			if (f.type !== model.name) continue;
			lines.push(f.line);
			blocks.push(other);
		}
	}
	p.editor.remove(lines, blocks);
	p.editor.removeBlock(
		findBlock(p.editor.schema, "model", model.name) as PrismaBlock
	);
}

function renameColumn(p: Patcher, plan: RenameColumnPlan): void {
	const schema = p.editor.schema;
	const model = requireModel(schema, plan.target);
	const field = scalarOf(schema, model, plan.column);
	if (field === undefined) {
		if (scalarOf(schema, model, plan.newName) !== undefined) return;
		throw missingField(model, plan.column);
	}
	// Un champ nommé selon la convention suit la colonne ; sinon seul `@map` change.
	const wanted =
		field.name === fieldName(plan.column, p.conventions)
			? fieldName(plan.newName, p.conventions)
			: field.name;
	const name =
		wanted !== field.name && fieldNames(schema, model).has(wanted)
			? field.name
			: wanted;
	rewriteField(p, model, field, (parts) => ({
		...parts,
		name,
		attributes:
			name === plan.newName
				? withoutAttribute(parts.attributes, "@map")
				: withAttribute(parts.attributes, {
						name: "@map",
						args: quote(plan.newName)
					})
	}));
	if (name !== field.name)
		renameFieldReferences(p, model.name, field.name, name);
	// Ces objets portent désormais le nom conventionnel de la nouvelle colonne.
	for (const r of plan.renames ?? []) dropMapArgument(p, model.name, r.from);
}

function alterColumn(p: Patcher, plan: AlterColumnPlan): void {
	const schema = p.editor.schema;
	const model = requireModel(schema, plan.target);
	const field = scalarOf(schema, model, plan.column);
	if (field === undefined) throw missingField(model, plan.column);
	const { action } = plan;
	switch (action.kind) {
		case "set-nullable":
		case "set-not-null":
			setOptional(p, model, field, action.kind === "set-nullable");
			break;
		case "set-default": {
			const isEnum = schema.blocks.some(
				(b) => b.kind === "enum" && b.name === field.type
			);
			const attribute = defaultAttribute(
				p,
				plan.target,
				plan.column,
				action.value,
				action.name,
				isEnum
			);
			rewriteField(p, model, field, (parts) => ({
				...parts,
				attributes:
					attribute !== undefined
						? withAttribute(parts.attributes, attribute)
						: withoutAttribute(parts.attributes, "@default")
			}));
			break;
		}
		case "drop-default":
			rewriteField(p, model, field, (parts) => ({
				...parts,
				attributes: withoutAttribute(parts.attributes, "@default")
			}));
			break;
		case "set-type":
			setType(p, model, field, action);
			break;
	}
}

/**
 * Nullabilité : le champ, et la relation dont il porte la FK. Prisma suppose
 * un `onDelete` selon l'optionalité de la relation : l'action de la base est
 * réécrite quand ce défaut change.
 */
function setOptional(
	p: Patcher,
	model: PrismaBlock,
	field: PrismaField,
	optional: boolean
): void {
	const schema = p.editor.schema;
	rewriteField(p, model, field, (parts) => ({ ...parts, optional }));
	const fields = modelFields(schema, model);
	for (const r of relationFields(schema, model)) {
		if (!r.fields.includes(field.name)) continue;
		const relationOptional = r.fields.some((name) =>
			name === field.name
				? optional
				: fields.find((f) => f.name === name)?.optional === true
		);
		if (relationOptional === r.field.optional) continue;
		const defaults = defaultActions(r.field.optional, p.provider);
		const actions = {
			onDelete: argument(r.args, "onDelete") ?? defaults.onDelete,
			onUpdate: argument(r.args, "onUpdate") ?? defaults.onUpdate
		};
		const args = relationArguments(
			r.args,
			referentialArguments(actions, relationOptional, p.provider)
		);
		rewriteField(p, model, r.field, (parts) => ({
			...parts,
			optional: relationOptional,
			attributes: parts.attributes.map((a) =>
				a.name === "@relation"
					? { name: a.name, args: renderArguments(args) }
					: a
			)
		}));
	}
}

/**
 * Type : le champ, et les champs liés à lui par FK, que SNQL change avec lui
 * (Prisma exige des types identiques). Sous SQL Server, un texte dont l'un
 * des champs est indexé passe en `nvarchar(450)`, tous ensemble. Le défaut
 * suit le nouveau type.
 */
function setType(
	p: Patcher,
	model: PrismaBlock,
	field: PrismaField,
	action: Extract<AlterColumnPlanAction, { kind: "set-type" }>
): void {
	const schema = p.editor.schema;
	const targets = [
		{ model, field },
		...foreignKeyPartners(schema, model, field)
	];
	const enumName =
		action.enumTypeName !== undefined
			? enumModelName(p, action.enumTypeName)
			: undefined;
	const scalar = prismaScalar(action.type, p.provider, {
		...(enumName !== undefined ? { enumTypeName: enumName } : {}),
		key: targets.some((t) => isIndexed(schema, t.model, t.field))
	});
	for (const target of targets) {
		rewriteField(p, target.model, target.field, (parts) => {
			let attributes = withoutAttribute(parts.attributes, "@db.");
			if (scalar.native !== undefined) {
				attributes = withAttribute(attributes, nativeAttribute(scalar.native));
			}
			return {
				...parts,
				type: scalar.type,
				attributes: attributes.map((a) =>
					a.name === "@default" && a.args !== undefined
						? {
								name: a.name,
								args: convertDefault(
									a.args,
									scalar.type,
									enumName !== undefined
								)
							}
						: a
				)
			};
		});
	}
}

// ─── Index ───────────────────────────────────────────────────────────────

function addIndex(p: Patcher, plan: AddIndexPlan): void {
	let schema = p.editor.schema;
	const model = requireModel(schema, plan.target);
	const fields = plan.fields.map((column) => {
		const field = scalarOf(schema, model, column);
		if (field === undefined) throw missingField(model, column);
		return field;
	});
	if (findIndex(p, schema, model, plan.name) !== undefined) return;
	if (p.provider === "sqlserver") {
		for (const field of fields) narrowToIndexable(p, model, field);
	}
	const isUnique = plan.kind === "add-unique-index";
	const map = mapArgument(
		plan.name,
		conventional(p, plan.target, plan.fields, isUnique ? "key" : "idx")
	);
	if (isUnique && fields.length === 1) {
		schema = p.editor.schema;
		const field = scalarOf(
			schema,
			model,
			plan.fields[0] as string
		) as PrismaField;
		rewriteField(p, model, field, (parts) => ({
			...parts,
			attributes: withAttribute(
				parts.attributes,
				attributeWith("@unique", [], map)
			)
		}));
		return;
	}
	insertBlockAttribute(
		p,
		model.name,
		renderAttribute(
			attributeWith(
				isUnique ? "@@unique" : "@@index",
				[{ value: `[${fields.map((f) => f.name).join(", ")}]` }],
				map
			)
		)
	);
}

function dropIndex(p: Patcher, table: string, name: string): void {
	const schema = p.editor.schema;
	const model = modelOfTable(schema, table);
	if (model === undefined) return;
	const found = findIndex(p, schema, model, name);
	if (found === undefined) return;
	if (found.field !== undefined) {
		rewriteField(p, model, found.field, (parts) => ({
			...parts,
			attributes: withoutAttribute(parts.attributes, "@unique")
		}));
		return;
	}
	p.editor.remove([found.line], [model]);
}

interface IndexLocation {
	readonly line: number;
	/** Unicité portée par le champ (`@unique`). */
	readonly field?: PrismaField;
}

/** Index ou unicité du modèle de nom `name` en base (`map:`, sinon le nom de Prisma). */
function findIndex(
	p: Patcher,
	schema: PrismaSchema,
	model: PrismaBlock,
	name: string
): IndexLocation | undefined {
	const table = tableOf(schema, model);
	for (const field of modelFields(schema, model)) {
		if (isModelType(schema, field.type)) continue;
		const attribute = parseAttributes(field.attributes).attributes.find(
			(a) => a.name === "@unique"
		);
		if (attribute === undefined) continue;
		const map = stringValue(
			argument(parseArguments(attribute.args ?? ""), "map")
		);
		if ((map ?? conventional(p, table, [columnOf(field)], "key")) === name) {
			return { line: field.line, field };
		}
	}
	for (const a of blockAttributes(schema, model)) {
		const attribute = parseAttributes(a.text).attributes[0];
		if (attribute?.name !== "@@unique" && attribute?.name !== "@@index")
			continue;
		const args = parseArguments(attribute.args ?? "");
		const columns = (indexFields(a.text) ?? []).map((f) =>
			columnOfField(schema, model, f)
		);
		// `@@index(name: …)` : ancienne forme de `map:`.
		const explicit =
			stringValue(argument(args, "map")) ??
			(attribute.name === "@@index"
				? stringValue(argument(args, "name"))
				: undefined);
		const suffix = attribute.name === "@@unique" ? "key" : "idx";
		if ((explicit ?? conventional(p, table, columns, suffix)) === name) {
			return { line: a.line };
		}
	}
	return undefined;
}

/** SQL Server : SNQL rétrécit un texte `(max)` qui entre dans un index. */
function narrowToIndexable(
	p: Patcher,
	model: PrismaBlock,
	field: PrismaField
): void {
	rewriteField(p, model, field, (parts) => {
		const native = parts.attributes.find((a) => a.name.startsWith("@db."));
		const narrowed =
			native !== undefined
				? SQLSERVER_INDEXABLE[renderAttribute(native).toLowerCase()]
				: undefined;
		return narrowed === undefined
			? parts
			: {
					...parts,
					attributes: withAttribute(parts.attributes, nativeAttribute(narrowed))
				};
	});
}

// ─── Relations ───────────────────────────────────────────────────────────

/**
 * Relation d'une FK : le champ de relation dans le modèle qui la porte, le
 * champ retour dans la cible. Une 2ᵉ relation entre les mêmes modèles (ou une
 * relation d'un modèle vers lui-même) est nommée, et les relations existantes
 * entre eux sans nom le deviennent.
 */
function addRelation(
	p: Patcher,
	table: string,
	ref: FieldRefPlan,
	oneToOne?: boolean
): void {
	let schema = p.editor.schema;
	const source = requireModel(schema, table);
	const target = requireModel(schema, ref.targetCollection);
	const from = scalarOf(schema, source, ref.fromColumn);
	if (from === undefined) throw missingField(source, ref.fromColumn);
	const to = scalarOf(schema, target, ref.targetColumn);
	if (to === undefined) throw missingField(target, ref.targetColumn);
	const modeled = relationFields(schema, source).some(
		(r) =>
			r.field.type === target.name &&
			r.fields.length === 1 &&
			r.fields[0] === from.name
	);
	if (modeled) return;
	const key = `${table}.${ref.fromColumn}`;
	const requested = p.requested.relations?.[key] ?? {};
	const between = relationsBetween(schema, source.name, target.name);
	const qualified = source.name === target.name || between.length > 0;
	for (const other of between) {
		if (other.name === undefined) {
			nameRelation(p, other.model.name, other.field.name);
		}
	}
	schema = p.editor.schema;
	const sourceBlock = findBlock(schema, "model", source.name) as PrismaBlock;
	const qualifier = relationQualifier(ref.fromColumn, ref.targetCollection);
	const naming: RelationNaming = {
		source: source.name,
		target: target.name,
		column: ref.fromColumn,
		...(qualified ? { qualifier } : {}),
		oneToOne: oneToOne ?? isUniqueField(schema, sourceBlock, from)
	};
	const name =
		requested.name ??
		(qualified
			? unique(
					relationName(source.name, qualifier),
					relationNames(schema, source.name, target.name)
				)
			: undefined);
	const sourceFields = fieldNames(schema, sourceBlock);
	const field = chosenName(
		requested.field,
		relationFieldName(naming, p.conventions),
		sourceFields,
		source.name
	);
	const targetFields =
		source.name === target.name
			? new Set([...sourceFields, field])
			: fieldNames(
					schema,
					findBlock(schema, "model", target.name) as PrismaBlock
				);
	const back = chosenName(
		requested.back,
		backFieldName(naming, p.conventions),
		targetFields,
		target.name
	);
	const args: PrismaArgument[] = [
		...(name !== undefined ? [{ value: quote(name) }] : []),
		{ key: "fields", value: `[${from.name}]` },
		{ key: "references", value: `[${to.name}]` },
		...referentialArguments(
			ref.emulated === true
				? { onDelete: "NoAction", onUpdate: "NoAction" }
				: {
						onDelete: prismaAction(ref.onDelete, p.provider),
						onUpdate: prismaAction(ref.onUpdate, p.provider)
					},
			from.optional,
			p.provider
		),
		...mapArgument(ref.name, conventional(p, table, [ref.fromColumn], "fkey"))
	];
	insertRelationField(
		p,
		source.name,
		renderField({
			indent: p.indent,
			name: field,
			type: target.name,
			list: false,
			optional: from.optional,
			attributes: [{ name: "@relation", args: renderArguments(args) }],
			tail: ref.emulated === true ? emulatedComment(ref) : ""
		}),
		true
	);
	insertRelationField(
		p,
		target.name,
		renderField({
			indent: p.indent,
			name: back,
			type: source.name,
			list: !naming.oneToOne,
			optional: naming.oneToOne,
			attributes:
				name !== undefined ? [{ name: "@relation", args: quote(name) }] : [],
			tail: ""
		}),
		false
	);
	p.relations[key] = { field, back, ...(name !== undefined ? { name } : {}) };
}

/**
 * FK compensée sous SQL Server (cycle ou 2ᵉ chemin de cascade, que Prisma
 * refuse aussi) : la base la porte en NO ACTION, des triggers font ses
 * actions. Le modèle décrit la base ; le commentaire dit ce qui se passe.
 */
function emulatedComment(ref: FieldRefPlan): string {
	const actions = [
		...(ref.onDelete !== "restrict"
			? [`on delete ${ref.onDelete.replace("-", " ")}`]
			: []),
		...(ref.onUpdate !== "restrict"
			? [`on update ${ref.onUpdate.replace("-", " ")}`]
			: [])
	];
	return `// SQLNest : ${actions.join(", ")} par trigger`;
}

/** Nom `@relation("…")` posé sur une relation existante et son champ retour. */
function nameRelation(p: Patcher, modelName: string, fieldName: string): void {
	const schema = p.editor.schema;
	const model = findBlock(schema, "model", modelName) as PrismaBlock;
	const owning = relationFields(schema, model).find(
		(r) => r.field.name === fieldName
	) as RelationField;
	const target = findBlock(schema, "model", owning.field.type) as PrismaBlock;
	const back = backFieldOf(schema, owning);
	const column = columnOfField(schema, model, owning.fields[0] as string);
	const key = `${tableOf(schema, model)}.${column}`;
	const name =
		p.requested.relations?.[key]?.name ??
		unique(
			relationName(
				model.name,
				relationQualifier(column, tableOf(schema, target))
			),
			relationNames(schema, model.name, target.name)
		);
	const named = (attribute: PrismaAttribute | undefined): PrismaAttribute => ({
		name: "@relation",
		args: renderArguments([
			{ value: quote(name) },
			...parseArguments(attribute?.args ?? "").filter(
				(a) => a.key !== undefined && a.key !== "name"
			)
		])
	});
	rewriteField(p, model, owning.field, (parts) => ({
		...parts,
		attributes: parts.attributes.map((a) =>
			a.name === "@relation" ? named(a) : a
		)
	}));
	if (back !== undefined) {
		rewriteField(p, back.model, back.field, (parts) => ({
			...parts,
			attributes: withAttribute(
				parts.attributes,
				named(parts.attributes.find((a) => a.name === "@relation"))
			)
		}));
	}
	p.relations[key] = { ...p.relations[key], name };
}

function dropRelation(p: Patcher, table: string, name: string): void {
	const schema = p.editor.schema;
	const model = modelOfTable(schema, table);
	if (model === undefined) return;
	const owning = relationFields(schema, model).filter(
		(r) => r.fields.length > 0 && foreignKeyName(p, schema, r) === name
	);
	p.editor.remove(
		relationLines(schema, owning),
		relationBlocks(schema, owning)
	);
}

function insertRelationField(
	p: Patcher,
	modelName: string,
	line: string,
	owning: boolean
): void {
	const schema = p.editor.schema;
	const model = findBlock(schema, "model", modelName) as PrismaBlock;
	const relations = relationFields(schema, model);
	const anchor =
		relations.filter((r) => r.fields.length > 0 === owning).at(-1) ??
		relations.at(-1);
	if (anchor !== undefined) {
		p.editor.insert(anchor.field.line + 1, [line], model);
		return;
	}
	const last = modelFields(schema, model).at(-1);
	p.editor.insert((last?.line ?? model.start) + 1, ["", line], model);
}

/** Lignes des champs de ces relations et de leurs champs retour. */
function relationLines(
	schema: PrismaSchema,
	relations: readonly RelationField[]
): number[] {
	return relations.flatMap((r) => {
		const back = backFieldOf(schema, r);
		return back !== undefined
			? [r.field.line, back.field.line]
			: [r.field.line];
	});
}

function relationBlocks(
	schema: PrismaSchema,
	relations: readonly RelationField[]
): PrismaBlock[] {
	return relations.flatMap((r) => {
		const back = backFieldOf(schema, r);
		return back !== undefined ? [r.model, back.model] : [r.model];
	});
}

function relationNames(
	schema: PrismaSchema,
	a: string,
	b: string
): Set<string> {
	return new Set(
		relationsBetween(schema, a, b).flatMap((r) =>
			r.name !== undefined ? [r.name] : []
		)
	);
}

/** Nom de FK en base : `map:`, sinon celui que Prisma donne. */
function foreignKeyName(
	p: Patcher,
	schema: PrismaSchema,
	relation: RelationField
): string {
	return (
		stringValue(argument(relation.args, "map")) ??
		conventional(
			p,
			tableOf(schema, relation.model),
			relation.fields.map((f) => columnOfField(schema, relation.model, f)),
			"fkey"
		)
	);
}

/**
 * Colonnes liées par FK à celle-ci, dans un sens ou dans l'autre, de proche
 * en proche : la chaîne entière garde un même type (comme le DDL de SNQL).
 */
function foreignKeyPartners(
	schema: PrismaSchema,
	model: PrismaBlock,
	field: PrismaField
): { model: PrismaBlock; field: PrismaField }[] {
	const found = [{ model, field }];
	const add = (
		block: PrismaBlock | undefined,
		name: string | undefined
	): void => {
		if (block === undefined || name === undefined) return;
		const partner = modelFields(schema, block).find((f) => f.name === name);
		if (partner === undefined) return;
		if (found.some((x) => x.field.line === partner.line)) return;
		found.push({ model: block, field: partner });
	};
	const relations = owningRelations(schema);
	for (let i = 0; i < found.length; i++) {
		const at = found[i] as { model: PrismaBlock; field: PrismaField };
		for (const r of relations) {
			r.fields.forEach((name, k) => {
				if (r.model.name === at.model.name && name === at.field.name) {
					add(findBlock(schema, "model", r.field.type), r.references[k]);
				}
				if (
					r.field.type === at.model.name &&
					r.references[k] === at.field.name
				) {
					add(r.model, name);
				}
			});
		}
	}
	return found.slice(1);
}

/**
 * SQL Server : la colonne d'une FK prend exactement le type de la colonne
 * qu'elle référence, avec les colonnes liées à elle par FK (DDL de SNQL) ; le
 * champ reprend le type Prisma et le type natif du champ référencé. Le défaut
 * suit le nouveau type.
 */
function alignForeignKeyType(
	p: Patcher,
	table: string,
	ref: FieldRefPlan
): void {
	if (p.provider !== "sqlserver") return;
	const schema = p.editor.schema;
	const source = requireModel(schema, table);
	const from = scalarOf(schema, source, ref.fromColumn);
	const to = scalarOf(
		schema,
		requireModel(schema, ref.targetCollection),
		ref.targetColumn
	);
	if (from === undefined || to === undefined) return;
	const native = parseAttributes(to.attributes).attributes.find((a) =>
		a.name.startsWith("@db.")
	);
	const nativeOf = (f: PrismaField): string | undefined => {
		const attribute = parseAttributes(f.attributes).attributes.find((a) =>
			a.name.startsWith("@db.")
		);
		return attribute !== undefined ? renderAttribute(attribute) : undefined;
	};
	const wanted = native !== undefined ? renderAttribute(native) : undefined;
	for (const target of [
		{ model: source, field: from },
		...foreignKeyPartners(schema, source, from)
	]) {
		if (target.field.type === to.type && nativeOf(target.field) === wanted) {
			continue;
		}
		rewriteField(p, target.model, target.field, (parts) => {
			const attributes = withoutAttribute(parts.attributes, "@db.");
			return {
				...parts,
				type: to.type,
				attributes: (native !== undefined
					? withAttribute(attributes, native)
					: attributes
				).map((a) =>
					// Pas d'enum Prisma sous SQL Server : du texte.
					a.name === "@default" &&
					a.args !== undefined &&
					parts.type !== to.type
						? { name: a.name, args: convertDefault(a.args, to.type, false) }
						: a
				)
			};
		});
	}
}

// ─── Enums ───────────────────────────────────────────────────────────────

/**
 * Prisma n'a pas d'enum sous SQL Server : la colonne y est un texte, et SNQL
 * range les enums dans une table que le modèle déclare (`@@ignore`), sans quoi
 * Prisma la voit en trop.
 */
function createEnum(p: Patcher, plan: CreateEnumPlan): void {
	if (p.provider === "sqlserver") {
		declareEnumsTable(p);
		return;
	}
	const schema = p.editor.schema;
	if (enumBlock(schema, plan.name) !== undefined) return;
	const enums = schema.blocks.filter((b) => b.kind === "enum");
	p.editor.insertBlock(
		[`enum ${plan.name} {`, ...plan.members.map((m) => p.indent + m), "}"],
		enums.at(-1) ?? schema.blocks.at(-1)
	);
}

function addEnumMember(p: Patcher, name: string, member: string): void {
	if (p.provider === "sqlserver") {
		declareEnumsTable(p);
		return;
	}
	const schema = p.editor.schema;
	const block = enumBlock(schema, name);
	if (block === undefined) {
		throw new PrismaPatchError(`schema.prisma n'a pas d'enum « ${name} »`);
	}
	const members = enumMembers(schema, block);
	if (members.some((m) => m.name === member)) return;
	p.editor.insert(
		(members.at(-1)?.line ?? block.start) + 1,
		[p.indent + member],
		block
	);
}

function dropEnum(p: Patcher, plan: DropEnumPlan): void {
	if (plan.cascade) {
		for (const { table, column } of enumColumns(p, plan.name)) {
			dropColumn(p, table, column);
		}
	}
	if (p.provider === "sqlserver") {
		declareEnumsTable(p);
		return;
	}
	const block = enumBlock(p.editor.schema, plan.name);
	if (block !== undefined) p.editor.removeBlock(block);
}

function declareEnumsTable(p: Patcher): void {
	const schema = p.editor.schema;
	if (modelOfTable(schema, SQLSERVER_ENUMS_TABLE) !== undefined) return;
	const name = unique("SnqlEnums", new Set(schema.blocks.map((b) => b.name)));
	p.editor.insertBlock(
		[
			"// Enums de SQLNest : SQL Server n'a pas de type enum.",
			`model ${name} {`,
			`${p.indent}name String @id @db.NVarChar(128)`,
			`${p.indent}members String @db.NVarChar(Max)`,
			"",
			`${p.indent}@@map(${quote(SQLSERVER_ENUMS_TABLE)})`,
			`${p.indent}@@ignore`,
			"}"
		],
		models(schema).at(-1) ?? schema.blocks.at(-1)
	);
}

/** Colonnes typées par un enum : le modèle les donne sous PostgreSQL, la base sous SQL Server. */
function enumColumns(
	p: Patcher,
	name: string
): { table: string; column: string }[] {
	if (p.provider === "sqlserver") {
		return p.db.collections.flatMap((c) =>
			c.fields
				.filter((f) => f.enumTypeName === name)
				.map((f) => ({ table: c.name, column: f.name }))
		);
	}
	const schema = p.editor.schema;
	const block = enumBlock(schema, name);
	if (block === undefined) return [];
	return models(schema).flatMap((m) =>
		modelFields(schema, m)
			.filter((f) => f.type === block.name)
			.map((f) => ({ table: tableOf(schema, m), column: columnOf(f) }))
	);
}

/** Bloc `enum` du type `name` en base (son `@@map`, sinon son nom). */
function enumBlock(
	schema: PrismaSchema,
	name: string
): PrismaBlock | undefined {
	return schema.blocks.find(
		(b) => b.kind === "enum" && tableOf(schema, b) === name
	);
}

function enumModelName(p: Patcher, name: string): string {
	return enumBlock(p.editor.schema, name)?.name ?? name;
}

function enumMembers(
	schema: PrismaSchema,
	block: PrismaBlock
): { name: string; line: number }[] {
	const members: { name: string; line: number }[] = [];
	for (let i = block.start + 1; i < block.end; i += 1) {
		const trimmed = (schema.lines[i] as string).trim();
		if (
			trimmed === "" ||
			trimmed.startsWith("//") ||
			trimmed.startsWith("@@")
		) {
			continue;
		}
		members.push({ name: trimmed.split(WHITESPACE_RE)[0] as string, line: i });
	}
	return members;
}

// ─── Champs et attributs ─────────────────────────────────────────────────

interface FieldParts {
	readonly indent: string;
	readonly name: string;
	readonly type: string;
	readonly list: boolean;
	readonly optional: boolean;
	readonly attributes: readonly PrismaAttribute[];
	readonly tail: string;
}

interface ScalarSpec {
	readonly table: string;
	readonly field: CreateTableField;
	readonly name: string;
	/** Seule colonne de la clé primaire : `@id`, avec le nom de la contrainte. */
	readonly primaryKey?: { readonly name: string | undefined };
	/** Colonne de clé ou d'unicité : texte en `nvarchar(450)` sous SQL Server. */
	readonly key: boolean;
}

function scalarField(p: Patcher, spec: ScalarSpec): string {
	const f = spec.field;
	const scalar = prismaScalar(f.type, p.provider, {
		...(f.enumTypeName !== undefined
			? { enumTypeName: enumModelName(p, f.enumTypeName) }
			: {}),
		key: spec.key
	});
	const attributes: PrismaAttribute[] = [];
	if (spec.primaryKey !== undefined) {
		attributes.push(
			attributeWith(
				"@id",
				[],
				mapArgument(
					spec.primaryKey.name,
					conventional(p, spec.table, [], "pkey")
				)
			)
		);
	} else if (f.unique) {
		attributes.push(
			attributeWith(
				"@unique",
				[],
				mapArgument(f.uniqueName, conventional(p, spec.table, [f.name], "key"))
			)
		);
	}
	if (f.defaultValue !== undefined) {
		const attribute = defaultAttribute(
			p,
			spec.table,
			f.name,
			f.defaultValue,
			f.defaultName,
			f.type === "enum"
		);
		if (attribute !== undefined) attributes.push(attribute);
	}
	if (spec.name !== f.name)
		attributes.push({ name: "@map", args: quote(f.name) });
	if (scalar.native !== undefined)
		attributes.push(nativeAttribute(scalar.native));
	return renderField({
		indent: p.indent,
		name: spec.name,
		type: scalar.type,
		list: false,
		optional: f.nullable,
		attributes,
		tail: ""
	});
}

/** `@default(…)`, avec le nom de sa contrainte sous SQL Server hors convention. */
function defaultAttribute(
	p: Patcher,
	table: string,
	column: string,
	value: DdlDefault,
	constraintName: string | undefined,
	isEnum: boolean
): PrismaAttribute | undefined {
	const prismaValue = prismaDefaultValue(value, p.provider, isEnum);
	if (prismaValue === undefined) return undefined;
	return attributeWith(
		"@default",
		[{ value: prismaValue }],
		p.provider === "sqlserver"
			? mapArgument(constraintName, conventional(p, table, [column], "df"))
			: []
	);
}

/** Défaut réécrit pour un nouveau type : `0` devient `"0"` pour un texte. */
function convertDefault(args: string, type: string, isEnum: boolean): string {
	const parsed = parseArguments(args);
	const first = parsed[0];
	if (
		first === undefined ||
		first.key !== undefined ||
		first.value.includes("(")
	) {
		return args;
	}
	const raw = stringValue(first.value) ?? first.value;
	const value = QUOTED_DEFAULT_TYPES.has(type) && !isEnum ? quote(raw) : raw;
	return renderArguments([{ value }, ...parsed.slice(1)]);
}

function rewriteField(
	p: Patcher,
	model: PrismaBlock,
	field: PrismaField,
	change: (parts: FieldParts) => FieldParts
): void {
	const raw = p.editor.line(field.line);
	const current = parseField(raw, field.line) as PrismaField;
	const line = parseAttributes(current.attributes);
	const parts: FieldParts = {
		indent: LEADING_SPACE_RE.exec(raw)?.[0] ?? p.indent,
		name: current.name,
		type: current.type,
		list: current.list,
		optional: current.optional,
		attributes: line.attributes,
		tail: line.tail
	};
	p.editor.replace(field.line, renderField(change(parts)), model);
}

function renderField(parts: FieldParts): string {
	const attributes = renderAttributes({
		attributes: parts.attributes,
		tail: parts.tail
	});
	const type = `${parts.type}${parts.list ? "[]" : ""}${parts.optional ? "?" : ""}`;
	return `${parts.indent}${parts.name} ${type}${attributes !== "" ? ` ${attributes}` : ""}`;
}

/** Ligne d'attribut de bloc (`@@index(…)`) réécrite, commentaire gardé. */
function rewriteBlockAttribute(
	p: Patcher,
	model: PrismaBlock,
	line: number,
	change: (attribute: PrismaAttribute) => PrismaAttribute
): void {
	const raw = p.editor.line(line);
	const parsed = parseAttributes(raw.trim());
	const [first, ...rest] = parsed.attributes;
	if (first === undefined) return;
	p.editor.replace(
		line,
		(LEADING_SPACE_RE.exec(raw)?.[0] ?? p.indent) +
			renderAttributes({
				attributes: [change(first), ...rest],
				tail: parsed.tail
			}),
		model
	);
}

function insertBlockAttribute(
	p: Patcher,
	modelName: string,
	text: string
): void {
	const schema = p.editor.schema;
	const model = findBlock(schema, "model", modelName) as PrismaBlock;
	const attributes = blockAttributes(schema, model);
	const indexes = attributes.filter((a) => indexFields(a.text) !== undefined);
	const anchor = indexes.at(-1);
	if (anchor !== undefined) {
		p.editor.insert(anchor.line + 1, [p.indent + text], model);
		return;
	}
	const first = attributes[0];
	if (first !== undefined) {
		p.editor.insert(first.line, [p.indent + text], model);
		return;
	}
	const last = modelFields(schema, model).at(-1);
	p.editor.insert(
		(last?.line ?? model.start) + 1,
		["", p.indent + text],
		model
	);
}

/** Renommage d'un champ dans les listes qui le citent : index, FK, références. */
function renameFieldReferences(
	p: Patcher,
	modelName: string,
	from: string,
	to: string
): void {
	const schema = p.editor.schema;
	const model = findBlock(schema, "model", modelName) as PrismaBlock;
	for (const a of blockAttributes(schema, model)) {
		if (indexFields(a.text)?.includes(from) !== true) continue;
		rewriteBlockAttribute(p, model, a.line, (attribute) => ({
			name: attribute.name,
			args: renderArguments(
				parseArguments(attribute.args ?? "").map((x) =>
					x.key === "fields" || (x.key === undefined && x.value.startsWith("["))
						? { ...x, value: renameInFieldList(x.value, from, to) }
						: x
				)
			)
		}));
	}
	for (const r of owningRelations(schema)) {
		const own = r.model.name === modelName && r.fields.includes(from);
		const referenced =
			r.field.type === modelName && r.references.includes(from);
		if (!own && !referenced) continue;
		rewriteField(p, r.model, r.field, (parts) => ({
			...parts,
			attributes: parts.attributes.map((a) =>
				a.name !== "@relation"
					? a
					: {
							name: a.name,
							args: renderArguments(
								parseArguments(a.args ?? "").map((x) =>
									(own && x.key === "fields") ||
									(referenced && x.key === "references")
										? { ...x, value: renameInFieldList(x.value, from, to) }
										: x
								)
							)
						}
			)
		}));
	}
}

/** `map: "<name>"` retiré des attributs du modèle qui le portent. */
function dropMapArgument(p: Patcher, modelName: string, name: string): void {
	const schema = p.editor.schema;
	const model = findBlock(schema, "model", modelName) as PrismaBlock;
	const strip = (a: PrismaAttribute): PrismaAttribute => {
		if (a.args === undefined) return a;
		const args = parseArguments(a.args);
		if (stringValue(argument(args, "map")) !== name) return a;
		const rest = withArgument(args, "map", undefined);
		return rest.length > 0
			? { name: a.name, args: renderArguments(rest) }
			: { name: a.name };
	};
	for (const field of modelFields(schema, model)) {
		if (!field.attributes.includes(quote(name))) continue;
		rewriteField(p, model, field, (parts) => ({
			...parts,
			attributes: parts.attributes.map(strip)
		}));
	}
	for (const a of blockAttributes(schema, model)) {
		if (!a.text.includes(quote(name))) continue;
		rewriteBlockAttribute(p, model, a.line, strip);
	}
}

/** Attribut posé à sa place (`@id @unique @default @map @db.…`), remplaçant son homonyme. */
function withAttribute(
	attributes: readonly PrismaAttribute[],
	attribute: PrismaAttribute
): PrismaAttribute[] {
	const same = (a: PrismaAttribute): boolean =>
		a.name === attribute.name ||
		(attribute.name.startsWith("@db.") && a.name.startsWith("@db."));
	const index = attributes.findIndex(same);
	if (index !== -1) {
		return attributes.flatMap((a, i) =>
			i === index ? [attribute] : same(a) ? [] : [a]
		);
	}
	const at = attributes.findIndex((a) => rank(a.name) > rank(attribute.name));
	return at === -1
		? [...attributes, attribute]
		: [...attributes.slice(0, at), attribute, ...attributes.slice(at)];
}

/** Sans l'attribut `name` (`@db.` : tout type natif). */
function withoutAttribute(
	attributes: readonly PrismaAttribute[],
	name: string
): PrismaAttribute[] {
	return attributes.filter((a) =>
		name.endsWith(".") ? !a.name.startsWith(name) : a.name !== name
	);
}

function rank(name: string): number {
	const index = ATTRIBUTE_ORDER.indexOf(
		name.startsWith("@db.") ? "@db." : name
	);
	return index === -1 ? ATTRIBUTE_ORDER.length : index;
}

function attributeWith(
	name: string,
	positional: readonly PrismaArgument[],
	named: readonly PrismaArgument[]
): PrismaAttribute {
	const args = [...positional, ...named];
	return args.length > 0 ? { name, args: renderArguments(args) } : { name };
}

function nativeAttribute(native: string): PrismaAttribute {
	return parseAttributes(native).attributes[0] as PrismaAttribute;
}

/** Arguments d'une relation, actions remplacées : nom, `fields`, `references`, actions, le reste. */
function relationArguments(
	args: readonly PrismaArgument[],
	referential: readonly PrismaArgument[]
): PrismaArgument[] {
	const head = (a: PrismaArgument): boolean =>
		a.key === undefined ||
		a.key === "name" ||
		a.key === "fields" ||
		a.key === "references";
	return [
		...args.filter(head),
		...referential,
		...args.filter(
			(a) => !head(a) && a.key !== "onDelete" && a.key !== "onUpdate"
		)
	];
}

/** `map: "…"` quand le nom de l'objet s'écarte de celui que Prisma donnerait. */
function mapArgument(
	name: string | undefined,
	expected: string
): PrismaArgument[] {
	return name !== undefined && name !== expected
		? [{ key: "map", value: quote(name) }]
		: [];
}

function conventional(
	p: Patcher,
	table: string,
	columns: readonly string[],
	suffix: "pkey" | "key" | "idx" | "fkey" | "df"
): string {
	return prismaConventionalName(p.engine, table, columns, suffix);
}

/** Champs listés par un `@@id` / `@@unique` / `@@index`, `undefined` pour un autre attribut. */
function indexFields(text: string): string[] | undefined {
	const attribute = parseAttributes(text).attributes[0];
	if (attribute === undefined || !INDEX_ATTRIBUTES.has(attribute.name)) {
		return undefined;
	}
	const args = parseArguments(attribute.args ?? "");
	const value =
		argument(args, "fields") ?? args.find((a) => a.key === undefined)?.value;
	return value !== undefined ? fieldList(value) : [];
}

function isUniqueField(
	schema: PrismaSchema,
	model: PrismaBlock,
	field: PrismaField
): boolean {
	const attributes = parseAttributes(field.attributes).attributes;
	if (attributes.some((a) => a.name === "@id" || a.name === "@unique")) {
		return true;
	}
	return blockAttributes(schema, model).some((a) => {
		const name = parseAttributes(a.text).attributes[0]?.name;
		const fields = indexFields(a.text);
		return (
			(name === "@@id" || name === "@@unique") &&
			fields?.length === 1 &&
			fields[0] === field.name
		);
	});
}

/** Champ dans une clé ou un index (SQL Server : texte en `nvarchar(450)`). */
function isIndexed(
	schema: PrismaSchema,
	model: PrismaBlock,
	field: PrismaField
): boolean {
	return (
		parseAttributes(field.attributes).attributes.some(
			(a) => a.name === "@id" || a.name === "@unique"
		) ||
		blockAttributes(schema, model).some(
			(a) => indexFields(a.text)?.includes(field.name) === true
		)
	);
}

function scalarOf(
	schema: PrismaSchema,
	model: PrismaBlock,
	column: string
): PrismaField | undefined {
	return modelFields(schema, model).find(
		(f) => !isModelType(schema, f.type) && columnOf(f) === column
	);
}

function columnOfField(
	schema: PrismaSchema,
	model: PrismaBlock,
	name: string
): string {
	const field = modelFields(schema, model).find((f) => f.name === name);
	return field !== undefined ? columnOf(field) : name;
}

function requireModel(schema: PrismaSchema, table: string): PrismaBlock {
	const model = modelOfTable(schema, table);
	if (model === undefined) {
		throw new PrismaPatchError(
			`schema.prisma n'a pas de modèle pour la table « ${table} »`
		);
	}
	return model;
}

function missingField(model: PrismaBlock, column: string): PrismaPatchError {
	return new PrismaPatchError(
		`Le modèle ${model.name} n'a pas de champ pour la colonne « ${column} »`
	);
}

/** Nom demandé (refusé s'il est pris), sinon le nom déduit rendu unique. */
function chosenName(
	requested: string | undefined,
	deduced: string,
	taken: ReadonlySet<string>,
	model: string
): string {
	if (requested === undefined) return unique(deduced, taken);
	if (taken.has(requested)) {
		throw new PrismaPatchError(
			`Le modèle ${model} a déjà un champ ${requested}`
		);
	}
	return requested;
}
