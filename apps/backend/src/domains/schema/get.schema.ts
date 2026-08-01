import z from "zod/v4";

const SnqlType = z.enum([
	"string",
	"int",
	"bigint",
	"float",
	"decimal",
	"bool",
	"date",
	"json",
	"array",
	"uuid",
	"unknown"
]);

const Source = z.enum(["declared", "inferred"]);

// Identifiant de schéma simple (miroir de la règle engine `SCHEMA_NAME_RE`) :
// rejette en 400 tout ce qui n'est pas `[a-z_][a-z0-9_]*` ≤63. Passer le param
// vide n'est pas supporté — omettre `schema` pour le défaut `public`.
const SchemaName = /^[a-z_][a-z0-9_]{0,62}$/;

const FieldSchema = z.object({
	name: z.string(),
	type: SnqlType,
	nullable: z.boolean(),
	source: Source,
	confidence: z.number().optional()
});

const CollectionSchema = z.object({
	name: z.string(),
	fields: z.array(FieldSchema).readonly(),
	primaryKey: z.array(z.string()).readonly().optional(),
	source: Source
});

const FieldRefSchema = z.object({
	collection: z.string(),
	fields: z.array(z.string()).readonly()
});

const RelationSchema = z.object({
	from: FieldRefSchema,
	to: FieldRefSchema,
	kind: z.enum(["one-to-many", "many-to-one", "one-to-one"]),
	origin: z.enum(["foreign-key", "naming-heuristic", "ai", "user"]),
	confidence: z.number()
});

export const GetSchemaResponseSchema = z.object({
	engine: z.string(),
	collections: z.array(CollectionSchema).readonly(),
	relations: z.array(RelationSchema).readonly()
});

export const GetSchemaQuerySchema = z.object({
	engine: z.enum(["postgres", "mongodb"]).default("postgres"),
	// Schéma cible Postgres (défaut `public`). Ignoré pour Mongo.
	schema: z.string().regex(SchemaName).optional()
});

export type GetSchemaResponse = z.infer<typeof GetSchemaResponseSchema>;
export type GetSchemaQuery = z.infer<typeof GetSchemaQuerySchema>;

z.globalRegistry.add(GetSchemaResponseSchema, { id: "SchemaModel" });
