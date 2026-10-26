/**
 * Zod schemas pour les routes proxifiées
 * `/api/db-connections/:id/schema` et `/api/db-connections/:id/query`.
 */

import z from "zod/v4";

export const ConnectionIdParams = z.object({
	id: z.uuid("`id` doit être un uuid")
});
z.globalRegistry.add(ConnectionIdParams, { id: "DbConnectionIdParams" });

/** Body de POST /api/db-connections/:id/query — source SNQL brut. Le
 *  CLI compile + exécute côté sa DB locale ; nous transportons juste
 *  le string dans un payload MessagePack signé. */
export const ProxyQueryBody = z.object({
	source: z.string().min(1, "`source` requis")
});
z.globalRegistry.add(ProxyQueryBody, { id: "DbConnectionsProxyQueryBody" });
export type ProxyQueryBodyT = z.infer<typeof ProxyQueryBody>;

/**
 * Span source SNQL sérialisé compact `[start, length]` — dupliqué ici pour ne
 * pas ajouter `@sqlnest/snql` en dep du backend (aligné sur `SerializedSpan`
 * dans `packages/snql/src/codegen/mapper.ts`).
 */
export const SerializedSpanSchema = z.tuple([
	z.number().int().nonnegative(),
	z.number().int().nonnegative()
]);

/**
 * Détail structuré d'une erreur Postgres remontée par le CLI (Phase 3a).
 * Aligné sur `PgErrorInfo` dans `packages/engine/src/errors.ts`. Les champs
 * sont **tous optionnels** — le CLI n'envoie que ceux disponibles sur l'objet
 * `pg.DatabaseError` reçu. `params`/`paramSpans` sont alignés positionnellement
 * avec les `$1..$N` du SQL généré (résolution `$N → span` côté frontend).
 */
export const PgErrorInfoSchema = z.object({
	message: z.string(),
	code: z.string().optional(),
	position: z.number().int().positive().optional(),
	detail: z.string().optional(),
	hint: z.string().optional(),
	column: z.string().optional(),
	table: z.string().optional(),
	constraint: z.string().optional(),
	params: z.array(z.unknown()).optional(),
	paramSpans: z.array(SerializedSpanSchema.optional()).optional(),
	rowSpans: z.array(SerializedSpanSchema.optional()).optional(),
	/**
	 * Phase 3b-lite : spans par nom d'ident. Résout `column "X" does not exist`
	 * → `identSpans["X"]` = toutes les positions source SNQL de l'ident.
	 */
	identSpans: z.record(z.string(), z.array(SerializedSpanSchema)).optional()
});
export type PgErrorInfoT = z.infer<typeof PgErrorInfoSchema>;

export const ProxyErrorResponse = z.object({
	message: z.string(),
	pgError: PgErrorInfoSchema.optional()
});
z.globalRegistry.add(ProxyErrorResponse, {
	id: "DbConnectionsProxyErrorResponse"
});

/**
 * Type SNQL d'une colonne. Aligné sur `SnqlType` de `packages/snql/src/
 * schema/model.ts`. On duplique ici pour ne pas ajouter `@sqlnest/snql`
 * en dep du backend (l'inférence tourne côté CLI).
 */
export const SnqlColumnType = z.enum([
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
	"enum",
	"unknown"
]);

/** Colonne du résultat renvoyée par `runSnql` — nom + type + nullable. */
export const ProxyQueryResultColumn = z.object({
	name: z.string(),
	type: SnqlColumnType,
	nullable: z.boolean()
});

/** Réponse 200 du `POST /api/teams/:slug/db-connections/:id/query`. */
export const ProxyQueryResponse = z.object({
	columns: z.array(ProxyQueryResultColumn),
	rows: z.array(z.record(z.string(), z.unknown())),
	rowCount: z.number().int(),
	written: z.boolean()
});
z.globalRegistry.add(ProxyQueryResponse, {
	id: "DbConnectionsProxyQueryResponse"
});
export type ProxyQueryResponseT = z.infer<typeof ProxyQueryResponse>;

/**
 * Réponse de GET /api/teams/:slug/db-connections/:id/project-status : le
 * projet relié à la connexion côté CLI (ADR-037 D2). Jamais son chemin.
 */
export const ProjectStatusResponse = z.object({
	linked: z.boolean(),
	orm: z.enum(["prisma", "doctrine", "sequelize", "seaorm"]).optional(),
	apply: z.boolean().optional(),
	projectFound: z.boolean().optional(),
	historyTable: z.object({ name: z.string(), present: z.boolean() }).optional(),
	migrations: z.boolean().optional()
});
z.globalRegistry.add(ProjectStatusResponse, {
	id: "DbConnectionsProjectStatusResponse"
});

/** Noms que la base ne donne pas, proposés et modifiables dans l'aperçu (ADR-037 D3). */
export const SchemaChangeNames = z.object({
	model: z.string().optional(),
	relations: z
		.record(
			z.string(),
			z.object({
				field: z.string().optional(),
				back: z.string().optional(),
				name: z.string().optional()
			})
		)
		.optional()
});

/** Corps de POST /api/teams/:slug/db-connections/:id/schema-change : un DDL SNQL. */
export const SchemaChangeBody = z.object({
	source: z.string().min(1).max(10_000),
	names: SchemaChangeNames.optional()
});
z.globalRegistry.add(SchemaChangeBody, { id: "DbConnectionsSchemaChangeBody" });

/**
 * Réponse de POST …/schema-change (ADR-037 D7) : migration écrite, appliquée
 * ou non, verdict de chaque contrôle. Chemins relatifs au projet, jamais le
 * contenu de ses fichiers.
 */
export const SchemaChangeResponse = z.object({
	orm: z.enum(["prisma", "doctrine", "sequelize", "seaorm"]),
	migration: z.string().optional(),
	files: z.array(z.string()),
	applied: z.boolean(),
	checks: z.array(
		z.object({
			name: z.enum(["model-database", "history-model", "structure"]),
			ok: z.boolean().optional(),
			skipped: z.string().optional(),
			diff: z.string().optional(),
			differences: z
				.array(
					z.object({
						target: z.string(),
						subject: z.string(),
						name: z.string().optional(),
						expected: z.string(),
						actual: z.string()
					})
				)
				.optional()
		})
	),
	names: SchemaChangeNames.optional()
});
z.globalRegistry.add(SchemaChangeResponse, {
	id: "DbConnectionsSchemaChangeResponse"
});
