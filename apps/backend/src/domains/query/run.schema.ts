import z from "zod/v4";

// Identifiant de schéma simple (miroir de la règle engine `SCHEMA_NAME_RE`).
const SchemaName = /^[a-z_][a-z0-9_]{0,62}$/;

export const RunQueryBodySchema = z.object({
	engine: z.enum(["postgres", "mongodb"]).default("postgres"),
	source: z.string().min(1),
	// Schéma cible Postgres (défaut `public`). Ignoré pour Mongo.
	schema: z.string().regex(SchemaName).optional()
});

export type RunQueryBody = z.infer<typeof RunQueryBodySchema>;
