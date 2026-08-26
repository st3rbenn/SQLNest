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
