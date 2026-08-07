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
