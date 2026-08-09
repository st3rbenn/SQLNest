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

export const ProxyErrorResponse = z.object({ message: z.string() });
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
