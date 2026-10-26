/**
 * Noms que la base ne donne pas (ADR-035 point 7) : modèle d'une nouvelle
 * table, champ de relation et son champ retour, nom `@relation("…")`. Déduits
 * des conventions du fichier ; l'aperçu de l'éditeur les propose et les laisse
 * modifier (ADR-037 D3).
 */

import {
	blockAttributes,
	columnOf,
	modelFields,
	type PrismaBlock,
	type PrismaSchema
} from "./schema-file";

const SNAKE_SPLIT_RE = /[_\s-]+/;
const ID_SUFFIX_RE = /(?:_id|_ID|Id)$/;
const UPPER_FIRST_RE = /^[A-Z]/;
const SIBILANT_END_RE = /(s|x|z|ch|sh)$/i;
const CONSONANT_Y_END_RE = /[^aeiou]y$/i;

/** `agency_tag` → `AgencyTag`. */
export function pascalCase(name: string): string {
	return name
		.split(SNAKE_SPLIT_RE)
		.filter((part) => part !== "")
		.map((part) => part[0]?.toUpperCase() + part.slice(1))
		.join("");
}

/** `created_at` → `createdAt`. */
export function camelCase(name: string): string {
	const pascal = pascalCase(name);
	return pascal.length > 0
		? pascal[0]?.toLowerCase() + pascal.slice(1)
		: pascal;
}

export interface FileConventions {
	/** Modèles en PascalCase avec `@@map("table")` ; sinon nommés comme la table. */
	readonly mappedModels: boolean;
	/** Champs en camelCase avec `@map("colonne")` ; sinon nommés comme la colonne. */
	readonly mappedFields: boolean;
	/** Champs de relation en PascalCase (`Agency Agency`, comme `db pull`) ; sinon camelCase. */
	readonly pascalRelations: boolean;
}

/** Conventions de la majorité des modèles du fichier. */
export function fileConventions(schema: PrismaSchema): FileConventions {
	const models = schema.blocks.filter((b) => b.kind === "model");
	const mapped = models.filter((m) =>
		blockAttributes(schema, m).some((a) => a.text.startsWith("@@map("))
	).length;
	let scalarFields = 0;
	let mappedFields = 0;
	let relationFields = 0;
	let pascalRelations = 0;
	const modelNames = new Set(models.map((m) => m.name));
	for (const model of models) {
		for (const field of modelFields(schema, model)) {
			if (modelNames.has(field.type)) {
				relationFields += 1;
				if (UPPER_FIRST_RE.test(field.name)) pascalRelations += 1;
				continue;
			}
			scalarFields += 1;
			if (columnOf(field) !== field.name) mappedFields += 1;
		}
	}
	const fieldsMapped = scalarFields > 0 && mappedFields * 2 > scalarFields;
	return {
		mappedModels: models.length === 0 || mapped * 2 >= models.length,
		mappedFields: fieldsMapped,
		pascalRelations:
			relationFields > 0 ? pascalRelations * 2 >= relationFields : !fieldsMapped
	};
}

/** Nom du modèle d'une table, selon les conventions du fichier. */
export function modelName(table: string, conventions: FileConventions): string {
	return conventions.mappedModels ? pascalCase(table) : table;
}

/** Nom du champ d'une colonne, selon les conventions du fichier. */
export function fieldName(
	column: string,
	conventions: FileConventions
): string {
	return conventions.mappedFields ? camelCase(column) : column;
}

/**
 * Ce qui distingue une relation d'une autre vers le même modèle : la colonne
 * sans `_id` ni le nom de la table cible, `backup_agency_id` → `Backup`.
 */
export function relationQualifier(column: string, targetTable: string): string {
	const base = column.replace(ID_SUFFIX_RE, "");
	const parts = base.split("_");
	const target = targetTable.toLowerCase().split("_");
	for (let i = 0; i + target.length <= parts.length; i += 1) {
		if (!target.every((part, j) => parts[i + j]?.toLowerCase() === part)) {
			continue;
		}
		const rest = [...parts.slice(0, i), ...parts.slice(i + target.length)];
		if (rest.some((part) => part !== "")) return pascalCase(rest.join("_"));
		break;
	}
	return pascalCase(base);
}

/** `AgencyTag` → `AgencyTags`, `Category` → `Categories`. */
export function plural(word: string): string {
	if (SIBILANT_END_RE.test(word)) return `${word}es`;
	if (CONSONANT_Y_END_RE.test(word)) return `${word.slice(0, -1)}ies`;
	return `${word}s`;
}

export interface RelationNaming {
	/** Modèle qui porte la FK. */
	readonly source: string;
	readonly target: string;
	/** Colonne de la FK. */
	readonly column: string;
	/** Ce qui distingue la relation d'une autre entre les mêmes modèles. */
	readonly qualifier?: string;
	/** FK unique : le champ retour est un objet, pas une liste. */
	readonly oneToOne: boolean;
}

/**
 * Champ de relation. Style `db pull` : le modèle cible, `Agency`, puis
 * `BackupAgency` pour une 2ᵉ relation. camelCase : la colonne sans `_id`,
 * `author_id` → `author`.
 */
export function relationFieldName(
	naming: RelationNaming,
	conventions: FileConventions
): string {
	const base = naming.column.replace(ID_SUFFIX_RE, "");
	if (!conventions.pascalRelations && base !== "" && base !== naming.column) {
		return camelCase(base);
	}
	return relationCase(`${naming.qualifier ?? ""}${naming.target}`, conventions);
}

/** Champ retour : `AgencyTag` (`db pull`), puis `BackupAgencyTags`. */
export function backFieldName(
	naming: RelationNaming,
	conventions: FileConventions
): string {
	const singular =
		naming.oneToOne ||
		(conventions.pascalRelations && naming.qualifier === undefined);
	const base = singular ? naming.source : plural(naming.source);
	return relationCase(`${naming.qualifier ?? ""}${base}`, conventions);
}

/** Nom `@relation("…")` : `AgencyTagBackup`. */
export function relationName(source: string, qualifier: string): string {
	return `${source}${qualifier}`;
}

function relationCase(name: string, conventions: FileConventions): string {
	return conventions.pascalRelations
		? name
		: (name[0]?.toLowerCase() ?? "") + name.slice(1);
}

/** Noms de champs d'un modèle, pour éviter une collision. */
export function fieldNames(
	schema: PrismaSchema,
	model: PrismaBlock
): Set<string> {
	return new Set(modelFields(schema, model).map((f) => f.name));
}

/** `name`, ou `name2`, `name3`… s'il est pris. */
export function unique(name: string, taken: ReadonlySet<string>): string {
	if (!taken.has(name)) return name;
	for (let i = 2; ; i += 1) {
		if (!taken.has(`${name}${i}`)) return `${name}${i}`;
	}
}
