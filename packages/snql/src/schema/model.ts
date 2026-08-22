/**
 * SchemaModel — l'« AST de la structure d'une base », unifié et engine-agnostique.
 * Produit par l'introspection (couche connexion), consommé par l'autocomplete, le
 * visualizer, le compilateur SNQL schema-aware et la détection de relations.
 * Voir le vault : `07 - Reader/SchemaModel`.
 */

/** Vocabulaire de types unifié, mappé depuis chaque moteur. Aligné sur `SqlValue`.
 * `enum` = type énuméré natif (PG). Les labels valides sont dans `Field.enumValues`.
 * Autres engines : mappé sur `string` (enum PG only pour l'instant). */
export type SnqlType =
	| "string"
	| "int"
	| "bigint"
	| "float"
	| "decimal"
	| "bool"
	| "date"
	| "json"
	| "array"
	| "uuid"
	| "enum"
	| "unknown";

/** `declared` = lu d'un schéma explicite (PG) ; `inferred` = déduit (sampling Mongo). */
export type SchemaSource = "declared" | "inferred";

/** D'où vient une relation — détermine la confiance qu'on peut lui accorder. */
export type RelationOrigin = "foreign-key" | "naming-heuristic" | "ai" | "user";

export type RelationKind = "one-to-many" | "many-to-one" | "one-to-one";

export interface Field {
	readonly name: string;
	readonly type: SnqlType;
	readonly nullable: boolean;
	readonly source: SchemaSource;
	/** 0..1 pour l'inféré (fréquence d'apparition en sampling). Absent = certain. */
	readonly confidence?: number;
	/**
	 * true si la colonne a un DEFAULT côté DB. Combiné avec
	 * `nullable`, permet à l'autocomplete de distinguer :
	 *   - `nullable: false && !hasDefault` → OBLIGATOIRE (l'user DOIT fournir la valeur)
	 *   - autre → facultatif (nullable ou default couvre l'absence)
	 * Absent = considéré `false` (conservateur : marque comme obligatoire si NOT NULL).
	 */
	readonly hasDefault?: boolean;
	/**
	 * labels valides pour un type enum. Peuplé par
	 * l'introspection PG (pg_enum). Utilisé par le complete (suggestions
	 * après `col:`) et un futur typecheck lower (refus tôt des invalides).
	 * Absent quand `type !== "enum"`.
	 */
	readonly enumValues?: readonly string[];
}

export interface Collection {
	readonly name: string;
	readonly fields: readonly Field[];
	readonly primaryKey?: readonly string[];
	readonly source: SchemaSource;
}

/** Un côté d'une relation : une (ou plusieurs, FK composite) colonnes d'une collection. */
export interface FieldRef {
	readonly collection: string;
	readonly fields: readonly string[];
}

export interface Relation {
	readonly from: FieldRef;
	readonly to: FieldRef;
	readonly kind: RelationKind;
	readonly origin: RelationOrigin;
	/** 0..1. FK explicite = 1 ; heuristique/IA < 1 ; confirmé user = 1. */
	readonly confidence: number;
}

/** Structure complète d'une base pour un moteur donné. */
export interface SchemaModel {
	readonly engine: string;
	readonly collections: readonly Collection[];
	readonly relations: readonly Relation[];
}
