import type { OnDeleteRule, OnUpdateRule, RefDef, Relation } from "@sqlnest/snql";

/**
 * Construction des `RefDef` / `Relation` d'un SchemaModel depuis les lignes FK
 * d'un catalogue relationnel — partagé PG (pg_constraint) / MSSQL
 * (sys.foreign_keys). Chaque source normalise ses lignes vers
 * `RelationalFkRow` (identité de contrainte + règles déjà mappées) ; le
 * grouping, le skip composite et le shape de sortie vivent ici, une fois.
 */

export interface RelationalFkRow {
	/**
	 * Identité STABLE de la contrainte (OID pg_constraint, object_id
	 * sys.foreign_keys) : les noms de contraintes ne sont uniques que par
	 * table — grouper par nom fusionnerait des FK homonymes.
	 */
	readonly constraintId: string;
	readonly constraintName: string;
	readonly fromTable: string;
	readonly fromColumn: string;
	readonly toTable: string;
	readonly toColumn: string;
	readonly onDelete: OnDeleteRule;
	readonly onUpdate: OnUpdateRule;
}

/**
 * Reconstruit les `RefDef` (ADR-031 FK/1a) — peuple `schema.refs`, base du
 * forward-nav FK/2a. Composite FK (> 1 colonne) skippée V1 : `RefDef` est
 * single-column ; le forward-nav ne cible pas les FK composites (ADR D5).
 * L'ordre d'entrée doit être trié par contrainte (les lignes d'une même
 * contrainte contiguës) — garanti par les ORDER BY des requêtes catalogue.
 */
export function buildRefsFromFkRows(rows: readonly RelationalFkRow[]): RefDef[] {
	const refs: RefDef[] = [];
	for (const group of groupByConstraint(rows).values()) {
		if (group.length !== 1) continue; // composite FK → hors scope nav V1
		const fk = group[0]!;
		refs.push({
			name: fk.constraintName,
			fromCollection: fk.fromTable,
			fromColumn: fk.fromColumn,
			toCollection: fk.toTable,
			toColumn: fk.toColumn,
			onDelete: fk.onDelete,
			onUpdate: fk.onUpdate,
			source: "declared"
		});
	}
	return refs;
}

/**
 * Chaque contrainte FK devient une relation `many-to-one` déclarée
 * (confidence 1). L'ordre des colonnes composites est préservé par l'ordre
 * d'entrée (ORDER BY ordinal des requêtes catalogue).
 */
export function buildRelationsFromFkRows(
	rows: readonly RelationalFkRow[]
): Relation[] {
	return [...groupByConstraint(rows).values()].map((group) => ({
		from: {
			collection: group[0]!.fromTable,
			fields: group.map((r) => r.fromColumn)
		},
		to: {
			collection: group[0]!.toTable,
			fields: group.map((r) => r.toColumn)
		},
		kind: "many-to-one" as const,
		origin: "foreign-key" as const,
		confidence: 1
	}));
}

function groupByConstraint(
	rows: readonly RelationalFkRow[]
): Map<string, RelationalFkRow[]> {
	const byConstraint = new Map<string, RelationalFkRow[]>();
	for (const row of rows) {
		const group = byConstraint.get(row.constraintId) ?? [];
		group.push(row);
		byConstraint.set(row.constraintId, group);
	}
	return byConstraint;
}
