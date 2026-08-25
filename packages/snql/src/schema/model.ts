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
	/**
	 * Nom de l'enum type si la colonne est typée par un enum nommé
	 * (ADR-030). Permet la résolution `type: role_type` dans le parser,
	 * l'autocomplete du cast `"user" as role_type` et le round-trip PG
	 * catalog (`pg_type.typname`). Absent quand la colonne a un type enum
	 * inline (rare) ou que ce n'est pas un enum.
	 */
	readonly enumTypeName?: string;
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

/**
 * Type énum nommé, scope per-schema (ADR-030). Réutilisable entre plusieurs
 * colonnes/tables. Introspection PG lit `pg_type` + `pg_enum` ; Mongo/KV
 * lisent leur metadata `_snql_enums`.
 */
export interface EnumTypeDef {
	readonly name: string;
	readonly members: readonly string[];
	readonly source: SchemaSource;
}

/** Structure complète d'une base pour un moteur donné. */
export interface SchemaModel {
	readonly engine: string;
	readonly collections: readonly Collection[];
	readonly relations: readonly Relation[];
	readonly enums?: readonly EnumTypeDef[];
}

/** Retourne le `EnumTypeDef` du schema par nom, ou `undefined` si absent. */
export function getEnum(
	schema: SchemaModel,
	name: string
): EnumTypeDef | undefined {
	return schema.enums?.find((e) => e.name === name);
}
