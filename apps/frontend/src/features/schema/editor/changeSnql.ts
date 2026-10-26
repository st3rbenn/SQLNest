/**
 * Geste du canvas → instruction SNQL (ADR-039 D2). Le SNQL est la seule
 * sortie d'un geste : le panneau le montre, la console le reprend tel quel.
 */

/** Geste en cours, ouvert dans le panneau de changement. */
export type ChangeGesture = {
	readonly kind: "add-column";
	readonly table: string;
};

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
