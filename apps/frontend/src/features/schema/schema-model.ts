// Miroir du type `SchemaModel` de `@sqlnest/snql` (découplé du runtime du cœur).
// Quand la route backend `/schema` existera, ce type viendra de l'OpenAPI généré.

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
	| "unknown";

export type SchemaSource = "declared" | "inferred";
export type RelationOrigin = "foreign-key" | "naming-heuristic" | "ai" | "user";
export type RelationKind = "one-to-many" | "many-to-one" | "one-to-one";

export interface Field {
	readonly name: string;
	readonly type: SnqlType;
	readonly nullable: boolean;
	readonly source: SchemaSource;
	readonly confidence?: number;
}

export interface Collection {
	readonly name: string;
	readonly fields: readonly Field[];
	readonly primaryKey?: readonly string[];
	readonly source: SchemaSource;
}

export interface FieldRef {
	readonly collection: string;
	readonly fields: readonly string[];
}

export interface Relation {
	readonly from: FieldRef;
	readonly to: FieldRef;
	readonly kind: RelationKind;
	readonly origin: RelationOrigin;
	readonly confidence: number;
}

export interface SchemaModel {
	readonly engine: string;
	readonly collections: readonly Collection[];
	readonly relations: readonly Relation[];
}

// --- Exemples : le même schéma logique vu par les DEUX moteurs ---
// Postgres : tout `declared` (catalogue + FK, confidence 1).
// MongoDB : tout `inferred` (sampling + heuristique de nommage, confidences < 1).

export const SAMPLE_POSTGRES: SchemaModel = {
	engine: "postgres",
	collections: [
		{
			name: "users",
			source: "declared",
			primaryKey: ["id"],
			fields: [
				{ name: "id", type: "bigint", nullable: false, source: "declared" },
				{ name: "email", type: "string", nullable: false, source: "declared" },
				{
					name: "display_name",
					type: "string",
					nullable: true,
					source: "declared"
				},
				{
					name: "is_active",
					type: "bool",
					nullable: false,
					source: "declared"
				},
				{
					name: "created_at",
					type: "date",
					nullable: false,
					source: "declared"
				}
			]
		},
		{
			name: "orders",
			source: "declared",
			primaryKey: ["id"],
			fields: [
				{ name: "id", type: "bigint", nullable: false, source: "declared" },
				{
					name: "user_id",
					type: "bigint",
					nullable: false,
					source: "declared"
				},
				{
					name: "total_cents",
					type: "bigint",
					nullable: false,
					source: "declared"
				},
				{ name: "status", type: "string", nullable: false, source: "declared" },
				{ name: "placed_at", type: "date", nullable: false, source: "declared" }
			]
		},
		{
			name: "products",
			source: "declared",
			primaryKey: ["id"],
			fields: [
				{ name: "id", type: "bigint", nullable: false, source: "declared" },
				{ name: "name", type: "string", nullable: false, source: "declared" },
				{
					name: "price_cents",
					type: "bigint",
					nullable: false,
					source: "declared"
				},
				{ name: "in_stock", type: "bool", nullable: false, source: "declared" }
			]
		},
		{
			name: "order_items",
			source: "declared",
			primaryKey: ["id"],
			fields: [
				{ name: "id", type: "bigint", nullable: false, source: "declared" },
				{
					name: "order_id",
					type: "bigint",
					nullable: false,
					source: "declared"
				},
				{
					name: "product_id",
					type: "bigint",
					nullable: false,
					source: "declared"
				},
				{ name: "quantity", type: "int", nullable: false, source: "declared" }
			]
		}
	],
	relations: [
		{
			from: { collection: "orders", fields: ["user_id"] },
			to: { collection: "users", fields: ["id"] },
			kind: "many-to-one",
			origin: "foreign-key",
			confidence: 1
		},
		{
			from: { collection: "order_items", fields: ["order_id"] },
			to: { collection: "orders", fields: ["id"] },
			kind: "many-to-one",
			origin: "foreign-key",
			confidence: 1
		},
		{
			from: { collection: "order_items", fields: ["product_id"] },
			to: { collection: "products", fields: ["id"] },
			kind: "many-to-one",
			origin: "foreign-key",
			confidence: 1
		}
	]
};

export const SAMPLE_MONGODB: SchemaModel = {
	engine: "mongodb",
	collections: [
		{
			name: "users",
			source: "inferred",
			primaryKey: ["_id"],
			fields: [
				{
					name: "_id",
					type: "bigint",
					nullable: false,
					source: "inferred",
					confidence: 1
				},
				{
					name: "email",
					type: "string",
					nullable: false,
					source: "inferred",
					confidence: 1
				},
				{
					name: "display_name",
					type: "string",
					nullable: true,
					source: "inferred",
					confidence: 0.67
				},
				{
					name: "is_active",
					type: "bool",
					nullable: false,
					source: "inferred",
					confidence: 1
				}
			]
		},
		{
			name: "orders",
			source: "inferred",
			primaryKey: ["_id"],
			fields: [
				{
					name: "_id",
					type: "bigint",
					nullable: false,
					source: "inferred",
					confidence: 1
				},
				{
					name: "user_id",
					type: "bigint",
					nullable: false,
					source: "inferred",
					confidence: 1
				},
				{
					name: "total_cents",
					type: "bigint",
					nullable: false,
					source: "inferred",
					confidence: 1
				},
				{
					name: "status",
					type: "string",
					nullable: false,
					source: "inferred",
					confidence: 1
				}
			]
		},
		{
			name: "products",
			source: "inferred",
			primaryKey: ["_id"],
			fields: [
				{
					name: "_id",
					type: "bigint",
					nullable: false,
					source: "inferred",
					confidence: 1
				},
				{
					name: "name",
					type: "string",
					nullable: false,
					source: "inferred",
					confidence: 1
				},
				{
					name: "price_cents",
					type: "bigint",
					nullable: false,
					source: "inferred",
					confidence: 0.9
				}
			]
		}
	],
	relations: [
		{
			from: { collection: "orders", fields: ["user_id"] },
			to: { collection: "users", fields: ["_id"] },
			kind: "many-to-one",
			origin: "naming-heuristic",
			confidence: 0.6
		}
	]
};
