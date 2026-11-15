/**
 * Geste du canvas → instruction SNQL (ADR-039 D2). Le SNQL est la seule
 * sortie d'un geste : le panneau le montre, la console le reprend tel quel.
 */

/** Geste en cours, ouvert dans le panneau de changement. */
export type ChangeGesture =
	| { readonly kind: "add-column"; readonly table: string }
	| ColumnGesture;

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
