/**
 * Relations d'un `schema.prisma` : le champ qui porte la FK
 * (`@relation(fields: […], references: […])`) et son champ retour dans le
 * modèle cible, appariés par nom de relation.
 */

import {
	argument,
	fieldList,
	type PrismaArgument,
	parseArguments,
	parseAttributes,
	stringValue
} from "./attributes";
import {
	findBlock,
	modelFields,
	type PrismaBlock,
	type PrismaField,
	type PrismaSchema
} from "./schema-file";

export interface RelationField {
	readonly model: PrismaBlock;
	readonly field: PrismaField;
	/** `@relation("…")` ; absent pour une relation sans nom. */
	readonly name?: string;
	/** Champs de la FK ; vides pour un champ retour. */
	readonly fields: readonly string[];
	readonly references: readonly string[];
	readonly args: readonly PrismaArgument[];
}

export function isModelType(schema: PrismaSchema, type: string): boolean {
	return schema.blocks.some((b) => b.kind === "model" && b.name === type);
}

export function models(schema: PrismaSchema): PrismaBlock[] {
	return schema.blocks.filter((b) => b.kind === "model");
}

/** Champs d'un modèle dont le type est un modèle. */
export function relationFields(
	schema: PrismaSchema,
	model: PrismaBlock
): RelationField[] {
	return modelFields(schema, model)
		.filter((field) => isModelType(schema, field.type))
		.map((field) => {
			const relation = parseAttributes(field.attributes).attributes.find(
				(a) => a.name === "@relation"
			);
			const args = parseArguments(relation?.args ?? "");
			const name = stringValue(
				args.find((a) => a.key === undefined)?.value ?? argument(args, "name")
			);
			const fields = argument(args, "fields");
			const references = argument(args, "references");
			return {
				model,
				field,
				...(name !== undefined ? { name } : {}),
				fields: fields !== undefined ? fieldList(fields) : [],
				references: references !== undefined ? fieldList(references) : [],
				args
			};
		});
}

/** Champs qui portent une FK, dans tous les modèles. */
export function owningRelations(schema: PrismaSchema): RelationField[] {
	return models(schema).flatMap((m) =>
		relationFields(schema, m).filter((r) => r.fields.length > 0)
	);
}

/** Champ retour d'une relation, dans le modèle cible. */
export function backFieldOf(
	schema: PrismaSchema,
	owning: RelationField
): RelationField | undefined {
	const target = findBlock(schema, "model", owning.field.type);
	if (target === undefined) return undefined;
	return relationFields(schema, target).find(
		(r) =>
			r.fields.length === 0 &&
			r.field.type === owning.model.name &&
			r.name === owning.name &&
			r.field.line !== owning.field.line
	);
}

/** Relations entre deux modèles, dans un sens ou dans l'autre. */
export function relationsBetween(
	schema: PrismaSchema,
	a: string,
	b: string
): RelationField[] {
	return owningRelations(schema).filter(
		(r) =>
			(r.model.name === a && r.field.type === b) ||
			(r.model.name === b && r.field.type === a)
	);
}
