/**
 * Schéma attendu après un plan DDL (ADR-037 D5) : le schéma d'avant, modifié
 * comme le DDL le décrit, sans moteur. `compareSchemas` le confronte à
 * l'introspection d'après ; l'aperçu de l'éditeur (E/3) l'affiche.
 *
 * Un nom que le moteur choisit lui-même (contrainte d'unicité sans nom imposé
 * par un profil) reste vide : la comparaison ne le juge pas.
 */

import type {
	AlterColumnPlanAction,
	CreateTableField,
	DDLPlan,
	DdlDefault,
	FieldRefPlan
} from "../ir/plan";
import { isDdlDefaultFn, isSqlDecimal, isSqlJsonLiteral } from "../ir/plan";
import {
	type Collection,
	type CollectionIndex,
	type Field,
	getFkPartners,
	type RefDef,
	type Relation,
	relationOfRef,
	type SchemaModel
} from "./model";

export function applyDdlToSchema(
	schema: SchemaModel,
	plan: DDLPlan
): SchemaModel {
	switch (plan.kind) {
		case "create-table": {
			if (schema.collections.some((c) => c.name === plan.target)) {
				return schema;
			}
			const collection: Collection = {
				name: plan.target,
				fields: plan.fields.map(fieldOf),
				...(plan.primaryKey !== undefined
					? { primaryKey: [...plan.primaryKey] }
					: {}),
				indexes: plan.fields.flatMap((f) =>
					f.unique ? [uniqueIndexOf(f)] : []
				),
				source: "declared"
			};
			return withRefs(
				{ ...schema, collections: [...schema.collections, collection] },
				plan.fields.flatMap((f) =>
					f.ref !== undefined ? [refOf(plan.target, f.ref)] : []
				)
			);
		}
		case "add-column": {
			const column = plan.column;
			const next = updateCollection(schema, plan.target, (c) =>
				c.fields.some((f) => f.name === column.name)
					? c
					: {
							...c,
							fields: [...c.fields, fieldOf(column)],
							...(column.unique
								? { indexes: [...(c.indexes ?? []), uniqueIndexOf(column)] }
								: {})
						}
			);
			return column.ref !== undefined && next !== schema
				? withRefs(next, [refOf(plan.target, column.ref)])
				: next;
		}
		case "add-index":
		case "add-unique-index":
			return updateCollection(schema, plan.target, (c) =>
				(c.indexes ?? []).some((i) => i.name === plan.name)
					? c
					: {
							...c,
							indexes: [
								...(c.indexes ?? []),
								{
									name: plan.name,
									columns: [...plan.fields],
									unique: plan.kind === "add-unique-index"
								}
							]
						}
			);
		case "drop-index":
			return updateCollection(schema, plan.target, (c) => ({
				...c,
				indexes: (c.indexes ?? []).filter((i) => i.name !== plan.name)
			}));
		case "drop-table":
			return {
				...schema,
				collections: schema.collections.filter((c) => c.name !== plan.target),
				relations: schema.relations.filter(
					(r) =>
						r.from.collection !== plan.target && r.to.collection !== plan.target
				),
				...refsWhere(
					schema,
					(r) =>
						r.fromCollection !== plan.target && r.toCollection !== plan.target
				)
			};
		case "drop-column":
			return dropColumn(schema, plan.target, plan.column);
		case "create-enum":
			return (schema.enums ?? []).some((e) => e.name === plan.name)
				? schema
				: {
						...schema,
						enums: [
							...(schema.enums ?? []),
							{
								name: plan.name,
								members: [...plan.members],
								source: "declared"
							}
						]
					};
		case "add-enum-member": {
			const enumDef = (schema.enums ?? []).find((e) => e.name === plan.name);
			if (enumDef === undefined || enumDef.members.includes(plan.member)) {
				return schema;
			}
			const members = [...enumDef.members, plan.member];
			return {
				...mapFields(schema, (_c, f) =>
					f.enumTypeName === plan.name ? { ...f, enumValues: members } : f
				),
				enums: (schema.enums ?? []).map((e) =>
					e.name === plan.name ? { ...e, members } : e
				)
			};
		}
		case "drop-enum": {
			let next: SchemaModel = {
				...schema,
				enums: (schema.enums ?? []).filter((e) => e.name !== plan.name)
			};
			if (plan.cascade) {
				for (const c of schema.collections) {
					for (const f of c.fields) {
						if (f.enumTypeName === plan.name) {
							next = dropColumn(next, c.name, f.name);
						}
					}
				}
			}
			return next;
		}
		case "add-ref":
			return withRefs(schema, [refOf(plan.target, plan.ref)]);
		case "drop-ref": {
			const dropped = (schema.refs ?? []).find(
				(r) => r.fromCollection === plan.target && r.name === plan.name
			);
			if (dropped === undefined) return schema;
			return {
				...schema,
				relations: schema.relations.filter((r) => !relationMatches(r, dropped)),
				...refsWhere(schema, (r) => r !== dropped)
			};
		}
		case "rename-column":
			return renameColumn(schema, plan);
		case "alter-column": {
			// `set type` emmène les colonnes liées par FK (PG, MSSQL).
			const columns = [
				{ table: plan.target, column: plan.column },
				...(plan.partners ?? [])
			];
			return {
				...schema,
				collections: schema.collections.map((c) => {
					const touched = columns
						.filter((t) => t.table === c.name)
						.map((t) => t.column);
					return touched.length === 0
						? c
						: {
								...c,
								fields: c.fields.map((f) =>
									touched.includes(f.name) ? alterField(f, plan.action) : f
								)
							};
				})
			};
		}
	}
}

function fieldOf(f: CreateTableField): Field {
	return {
		name: f.name,
		type: f.type,
		nullable: f.nullable,
		source: "declared",
		...(f.defaultValue !== undefined
			? { hasDefault: true, defaultExpr: defaultText(f.defaultValue) }
			: {}),
		...(f.enumMembers !== undefined ? { enumValues: [...f.enumMembers] } : {}),
		...(f.enumTypeName !== undefined ? { enumTypeName: f.enumTypeName } : {}),
		...(f.storedAs !== undefined ? { storedAs: f.storedAs } : {})
	};
}

/** Contrainte d'unicité d'une colonne ; nom vide quand le moteur le choisit. */
function uniqueIndexOf(f: CreateTableField): CollectionIndex {
	return { name: f.uniqueName ?? "", columns: [f.name], unique: true };
}

function refOf(table: string, ref: FieldRefPlan): RefDef {
	return {
		name: ref.name,
		fromCollection: table,
		fromColumn: ref.fromColumn,
		toCollection: ref.targetCollection,
		toColumn: ref.targetColumn,
		onDelete: ref.onDelete,
		onUpdate: ref.onUpdate,
		source: "declared",
		...(ref.emulated === true ? { emulated: true } : {})
	};
}

function relationMatches(relation: Relation, ref: RefDef): boolean {
	return (
		relation.origin === "foreign-key" &&
		relation.from.collection === ref.fromCollection &&
		relation.to.collection === ref.toCollection &&
		relation.from.fields.length === 1 &&
		relation.from.fields[0] === ref.fromColumn &&
		relation.to.fields[0] === ref.toColumn
	);
}

/** FK ajoutées, et leurs relations. */
function withRefs(schema: SchemaModel, refs: readonly RefDef[]): SchemaModel {
	if (refs.length === 0) return schema;
	return withRefTypes(
		{
			...schema,
			refs: [...(schema.refs ?? []), ...refs],
			relations: [...schema.relations, ...refs.map(relationOfRef)]
		},
		refs
	);
}

/**
 * SQL Server : la colonne d'une FK prend le type de la colonne référencée,
 * avec les colonnes liées à elle par FK (codegen MSSQL) — un `int` qui
 * référence un `bigint` devient `bigint`.
 */
function withRefTypes(
	schema: SchemaModel,
	refs: readonly RefDef[]
): SchemaModel {
	if (schema.engine !== "mssql") return schema;
	let next = schema;
	for (const ref of refs) {
		const type = next.collections
			.find((c) => c.name === ref.toCollection)
			?.fields.find((f) => f.name === ref.toColumn)?.type;
		if (type === undefined) continue;
		const columns = [
			{ table: ref.fromCollection, column: ref.fromColumn },
			...getFkPartners(next, ref.fromCollection, ref.fromColumn)
		];
		for (const { table, column } of columns) {
			next = updateCollection(next, table, (c) =>
				c.fields.some((f) => f.name === column && f.type !== type)
					? {
							...c,
							fields: c.fields.map((f) =>
								f.name === column ? { ...f, type } : f
							)
						}
					: c
			);
		}
	}
	return next;
}

/** `refs` filtrées, la clé gardée absente si elle l'était. */
function refsWhere(
	schema: SchemaModel,
	keep: (r: RefDef) => boolean
): Pick<SchemaModel, "refs"> {
	return schema.refs !== undefined ? { refs: schema.refs.filter(keep) } : {};
}

function updateCollection(
	schema: SchemaModel,
	name: string,
	update: (c: Collection) => Collection
): SchemaModel {
	let changed = false;
	const collections = schema.collections.map((c) => {
		if (c.name !== name) return c;
		const next = update(c);
		if (next !== c) changed = true;
		return next;
	});
	return changed ? { ...schema, collections } : schema;
}

function mapFields(
	schema: SchemaModel,
	map: (c: Collection, f: Field) => Field
): SchemaModel {
	return {
		...schema,
		collections: schema.collections.map((c) => ({
			...c,
			fields: c.fields.map((f) => map(c, f))
		}))
	};
}

/** La colonne disparaît, avec les index, la clé primaire et les FK qui la portent. */
function dropColumn(
	schema: SchemaModel,
	table: string,
	column: string
): SchemaModel {
	const touches = (r: RefDef): boolean =>
		(r.fromCollection === table && r.fromColumn === column) ||
		(r.toCollection === table && r.toColumn === column);
	const dropped = (schema.refs ?? []).filter(touches);
	const next = updateCollection(schema, table, (c) => {
		const { primaryKey, ...rest } = c;
		return {
			...rest,
			fields: c.fields.filter((f) => f.name !== column),
			...(primaryKey !== undefined && !primaryKey.includes(column)
				? { primaryKey }
				: {}),
			...(c.indexes !== undefined
				? { indexes: c.indexes.filter((i) => !i.columns.includes(column)) }
				: {})
		};
	});
	return {
		...next,
		relations: next.relations.filter(
			(r) =>
				!dropped.some((ref) => relationMatches(r, ref)) &&
				!(r.from.collection === table && r.from.fields.includes(column)) &&
				!(r.to.collection === table && r.to.fields.includes(column))
		),
		...refsWhere(next, (r) => !touches(r))
	};
}

/** La colonne change de nom partout où elle est citée ; les noms d'un profil ORM suivent. */
function renameColumn(
	schema: SchemaModel,
	plan: Extract<DDLPlan, { kind: "rename-column" }>
): SchemaModel {
	const { target, column, newName } = plan;
	const rename = (name: string): string => (name === column ? newName : name);
	const renamed = (kind: "index" | "foreign-key", name: string): string =>
		plan.renames?.find((r) => r.kind === kind && r.from === name)?.to ?? name;
	const next = updateCollection(schema, target, (c) => ({
		...c,
		fields: c.fields.map((f) =>
			f.name === column ? { ...f, name: newName } : f
		),
		...(c.primaryKey !== undefined
			? { primaryKey: c.primaryKey.map(rename) }
			: {}),
		...(c.indexes !== undefined
			? {
					indexes: c.indexes.map((i) => ({
						...i,
						name: renamed("index", i.name),
						columns: i.columns.map(rename)
					}))
				}
			: {})
	}));
	return {
		...next,
		relations: next.relations.map((r) => ({
			...r,
			from:
				r.from.collection === target
					? { ...r.from, fields: r.from.fields.map(rename) }
					: r.from,
			to:
				r.to.collection === target
					? { ...r.to, fields: r.to.fields.map(rename) }
					: r.to
		})),
		...(next.refs !== undefined
			? {
					refs: next.refs.map((r) => ({
						...r,
						name:
							r.fromCollection === target
								? renamed("foreign-key", r.name)
								: r.name,
						fromColumn:
							r.fromCollection === target ? rename(r.fromColumn) : r.fromColumn,
						toColumn:
							r.toCollection === target ? rename(r.toColumn) : r.toColumn
					}))
				}
			: {})
	};
}

function alterField(field: Field, action: AlterColumnPlanAction): Field {
	switch (action.kind) {
		case "set-nullable":
			return { ...field, nullable: true };
		case "set-not-null":
			return { ...field, nullable: false };
		case "set-default":
			return {
				...field,
				hasDefault: true,
				defaultExpr: defaultText(action.value)
			};
		case "drop-default": {
			const {
				hasDefault: _hasDefault,
				defaultExpr: _defaultExpr,
				...rest
			} = field;
			return rest;
		}
		case "set-type": {
			const {
				enumValues: _values,
				enumTypeName: _typeName,
				storedAs: _storedAs,
				...rest
			} = field;
			return {
				...rest,
				type: action.type,
				...(action.enumMembers !== undefined
					? { enumValues: [...action.enumMembers] }
					: {}),
				...(action.enumTypeName !== undefined
					? { enumTypeName: action.enumTypeName }
					: {}),
				...(action.storedAs !== undefined ? { storedAs: action.storedAs } : {})
			};
		}
	}
}

/** Texte d'un défaut comme SNQL l'écrit : `now()`, `uuid()`, la valeur littérale. */
function defaultText(value: DdlDefault): string {
	if (isDdlDefaultFn(value)) return `${value.fn}()`;
	if (isSqlJsonLiteral(value) || isSqlDecimal(value)) return value.raw;
	if (typeof value === "bigint") return value.toString();
	return JSON.stringify(value);
}
