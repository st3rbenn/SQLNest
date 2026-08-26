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

/**
 * Règle appliquée quand la ligne référencée est supprimée (ADR-031 D2).
 * `restrict` = refus si des lignes dépendent (défaut défensif). `cascade` =
 * supprime les dépendants. `set-null` = met le champ référençant à NULL
 * (requiert que la colonne soit nullable).
 */
export type OnDeleteRule = "restrict" | "cascade" | "set-null";

/** Règle sur update de la clé référencée (ADR-031). `cascade` propage la
 * nouvelle valeur ; `restrict` refuse. `set-null` rare (souvent inutile sur PK
 * immutable) mais admis pour symétrie. */
export type OnUpdateRule = "restrict" | "cascade" | "set-null";

/**
 * Foreign-key déclarée via SNQL DDL (`ref users.id [on delete ...]`, ADR-031).
 * Distincte de `Relation` (résultat introspection/inférence) : `RefDef` porte
 * les règles cascade + le nom de contrainte que le codegen a besoin d'émettre
 * et que l'adapter runtime consomme pour la compensation Mongo/KV. Après un
 * cycle d'introspection, un `RefDef` PG apparaît aussi comme un `Relation`
 * `origin: "foreign-key"` — les deux coexistent (rules ici, graphe là).
 */
export interface RefDef {
	/** Nom de contrainte (auto-généré `fk_<table>_<col>_<target>` ou `as`). */
	readonly name: string;
	/** Collection + colonne portant la FK (le côté « many »). */
	readonly fromCollection: string;
	readonly fromColumn: string;
	/** Collection + colonne référencée (le côté « one », typiquement une PK). */
	readonly toCollection: string;
	readonly toColumn: string;
	readonly onDelete: OnDeleteRule;
	readonly onUpdate: OnUpdateRule;
	readonly source: SchemaSource;
}

/** Structure complète d'une base pour un moteur donné. */
export interface SchemaModel {
	readonly engine: string;
	readonly collections: readonly Collection[];
	readonly relations: readonly Relation[];
	readonly enums?: readonly EnumTypeDef[];
	/** FK déclarées (ADR-031). Introspection PG `pg_constraint` ; Mongo/KV
	 * lisent `_snql_refs`. Absent = aucune FK déclarée. */
	readonly refs?: readonly RefDef[];
}

/** Retourne le `EnumTypeDef` du schema par nom, ou `undefined` si absent. */
export function getEnum(
	schema: SchemaModel,
	name: string
): EnumTypeDef | undefined {
	return schema.enums?.find((e) => e.name === name);
}

/** FK sortantes d'une collection (le côté référençant `many`). */
export function getOutgoingRefs(
	schema: SchemaModel,
	collection: string
): readonly RefDef[] {
	return schema.refs?.filter((r) => r.fromCollection === collection) ?? [];
}

/** FK entrantes vers une collection (le côté référencé `one`) — base du
 * reverse-nav `find users pick orders.count` (ADR-031 D7, FK/2). */
export function getIncomingRefs(
	schema: SchemaModel,
	collection: string
): readonly RefDef[] {
	return schema.refs?.filter((r) => r.toCollection === collection) ?? [];
}
