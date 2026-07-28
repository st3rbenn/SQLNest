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

const FieldSchema = z.object({
	name: z.string(),
	type: SnqlType,
	nullable: z.boolean(),
	source: Source,
	confidence: z.number().optional()
});

const CollectionSchema = z.object({
	name: z.string(),
	fields: z.array(FieldSchema),
	primaryKey: z.array(z.string()).optional(),
	source: Source
});

const FieldRefSchema = z.object({
	collection: z.string(),
	fields: z.array(z.string())
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
	collections: z.array(CollectionSchema),
	relations: z.array(RelationSchema)
});

export const GetSchemaQuerySchema = z.object({
	engine: z.enum(["postgres", "mongodb"]).default("postgres")
});

export type GetSchemaResponse = z.infer<typeof GetSchemaResponseSchema>;
export type GetSchemaQuery = z.infer<typeof GetSchemaQuerySchema>;

z.globalRegistry.add(GetSchemaResponseSchema, { id: "SchemaModel" });
