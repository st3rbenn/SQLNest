/**
 * Geste du canvas → instruction SNQL (ADR-039 D2). Le SNQL est la seule
 * sortie d'un geste : le panneau le montre, la console le reprend tel quel.
 */

/** Geste en cours, ouvert dans le panneau de changement. */
export type ChangeGesture =
	| { readonly kind: "create-table" }
	| { readonly kind: "drop-table"; readonly table: string }
	| { readonly kind: "add-column"; readonly table: string }
	| { readonly kind: "create-enum" }
	| { readonly kind: "add-enum-member"; readonly enumName: string }
	| { readonly kind: "add-index"; readonly table: string }
	| { readonly kind: "drop-index"; readonly table: string; readonly name: string }
	| ColumnGesture
	| AddRefGesture
	| DropRefGesture;

/** Relation tracée d'un champ (qui portera la FK) vers le champ référencé. */
export interface AddRefGesture {
	readonly kind: "add-ref";
	readonly table: string;
	readonly column: string;
	readonly targetTable: string;
	readonly targetColumn: string;
}

/** FK retirée depuis le menu de son arête. */
export interface DropRefGesture {
	readonly kind: "drop-ref";
	readonly table: string;
	readonly column: string;
	readonly targetTable: string;
	readonly targetColumn: string;
	/** Nom de la contrainte. */
	readonly name: string;
}

/** Geste sur une colonne existante (menu du champ, double-clic sur son nom). */
export type ColumnGesture = {
	readonly table: string;
	readonly column: string;
} & (
	| {
			readonly kind:
				| "rename-column"
				| "set-type"
				| "set-default"
				| "drop-default"
				| "drop-column";
	  }
	/** Nullabilité visée, lue sur la colonne à l'ouverture du geste. */
	| { readonly kind: "set-nullability"; readonly nullable: boolean }
);

/** Types proposés pour une colonne : les noms canoniques du parseur SNQL. */
export const COLUMN_TYPES = [
	"string",
	"int",
	"bigint",
	"float",
	"decimal",
	"bool",
	"date",
	"json",
	"array",
	"uuid"
] as const;

/** Types proposés pour la clé primaire d'une nouvelle table. */
export const KEY_TYPES = ["int", "bigint", "uuid", "string"] as const;

export interface CreateTableDraft {
	readonly name: string;
	readonly keyName: string;
	readonly keyType: string;
}

/** Une table naît avec sa clé primaire ; ses colonnes s'ajoutent ensuite, une par geste. */
export function createTableSnql(d: CreateTableDraft): string {
	const key = d.keyName.trim();
	return `create table ${d.name.trim()} { ${key}: ${d.keyType}, primary key (${key}) }`;
}

export function dropTableSnql(table: string): string {
	return `drop table ${table}`;
}

/** Valeur d'enum écrite en littéral SNQL. */
function enumLiteral(value: string): string {
	return JSON.stringify(value);
}

/** `values` : une valeur par ligne, les lignes vides ignorées. */
export function createEnumSnql(name: string, values: string): string {
	const members = values
		.split("\n")
		.map((v) => v.trim())
		.filter((v) => v !== "")
		.map(enumLiteral);
	return `create enum ${name.trim()} { ${members.join(", ")} }`;
}

export function addEnumMemberSnql(enumName: string, value: string): string {
	return `add enum member ${enumName} ${enumLiteral(value.trim())}`;
}

export interface AddIndexDraft {
	readonly table: string;
	/** Colonnes de la clé, dans l'ordre choisi. */
	readonly columns: readonly string[];
	readonly unique: boolean;
}

export function addIndexSnql(d: AddIndexDraft): string {
	return `add ${d.unique ? "unique " : ""}index (${d.columns.join(", ")}) into ${d.table}`;
}

export function dropIndexSnql(table: string, name: string): string {
	return `drop index ${name} from ${table}`;
}

export interface AddColumnDraft {
	readonly table: string;
	readonly name: string;
	/** Type SNQL, ou nom d'un enum du schéma. */
	readonly type: string;
	readonly nullable: boolean;
	/** Défaut écrit en SNQL (`"x"`, `0`, `now()`, `uuid()`) ; vide : sans défaut. */
	readonly defaultExpr: string;
}

export function addColumnSnql(d: AddColumnDraft): string {
	const defaultExpr = d.defaultExpr.trim();
	return [
		`add column ${d.name.trim()} ${d.type}`,
		...(d.nullable ? ["nullable"] : []),
		...(defaultExpr !== "" ? [`default ${defaultExpr}`] : []),
		`into ${d.table}`
	].join(" ");
}

export function renameColumnSnql(
	table: string,
	column: string,
	newName: string
): string {
	return `rename column ${table}.${column} to ${newName.trim()}`;
}

export function setTypeSnql(
	table: string,
	column: string,
	type: string
): string {
	return `alter column ${table}.${column} set type ${type}`;
}

export function setNullabilitySnql(
	table: string,
	column: string,
	nullable: boolean
): string {
	return `alter column ${table}.${column} ${nullable ? "set nullable" : "set not null"}`;
}

/** Défaut écrit en SNQL. */
export function setDefaultSnql(
	table: string,
	column: string,
	defaultExpr: string
): string {
	return `alter column ${table}.${column} set default ${defaultExpr.trim()}`;
}

export function dropDefaultSnql(table: string, column: string): string {
	return `alter column ${table}.${column} drop default`;
}

export function dropColumnSnql(table: string, column: string): string {
	return `drop column ${column} from ${table}`;
}

/** Règle d'une FK quand la ligne référencée est supprimée ou que sa clé change. */
export const REF_RULES = ["restrict", "cascade", "set null"] as const;
export type RefRule = (typeof REF_RULES)[number];

export interface AddRefDraft {
	readonly table: string;
	readonly column: string;
	readonly targetTable: string;
	readonly targetColumn: string;
	readonly onDelete: RefRule;
	readonly onUpdate: RefRule;
}

/** Règles qu'une relation reçoit quand le SNQL n'en écrit aucune. */
export interface RefRuleDefaults {
	readonly onDelete: RefRule;
	readonly onUpdate: RefRule;
}

/** Défauts du langage. Un profil d'ORM peut en poser d'autres (`defaultRefRules`). */
export const LANGUAGE_REF_RULES: RefRuleDefaults = {
	onDelete: "restrict",
	onUpdate: "restrict"
};

/** Une règle ne s'écrit que si elle diffère de celle que le mode appliquerait seul. */
export function addRefSnql(
	d: AddRefDraft,
	defaults: RefRuleDefaults = LANGUAGE_REF_RULES
): string {
	return [
		`add ref (${d.column}) references ${d.targetTable}.${d.targetColumn}`,
		...(d.onDelete !== defaults.onDelete ? [`on delete ${d.onDelete}`] : []),
		...(d.onUpdate !== defaults.onUpdate ? [`on update ${d.onUpdate}`] : []),
		`into ${d.table}`
	].join(" ");
}

export function dropRefSnql(table: string, name: string): string {
	return `drop ref ${name} from ${table}`;
}
