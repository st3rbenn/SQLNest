/**
 * Schémas Zod pour la route `/api/db-connections`.
 */

import z from "zod/v4";

export const ListDbConnectionsResponse = z.object({
	connections: z.array(
		z.object({
			id: z.string(),
			name: z.string(),
			engine: z.string(),
			cliFingerprint: z.string(),
			engineMetadata: z.unknown(),
			activeSince: z.string(),
			lastSeenAt: z.string().nullable(),
			createdAt: z.string(),
			/** `true` si un CLI est actuellement connecté au tunnel WSS pour
			 *  cette connection (registry in-memory). Utilisé côté frontend
			 *  pour :
			 *   - afficher un badge "online" dans la gallery (v1.x)
			 *   - auto-refetch le schema quand le CLI reconnecte
			 *     (transition false→true déclenche invalidation cache). */
			isOnline: z.boolean()
		})
	)
});
z.globalRegistry.add(ListDbConnectionsResponse, {
	id: "ListDbConnectionsResponse"
});
export type ListDbConnectionsResponseT = z.infer<
	typeof ListDbConnectionsResponse
>;

export const DbConnectionsErrorResponse = z.object({ message: z.string() });
z.globalRegistry.add(DbConnectionsErrorResponse, {
	id: "DbConnectionsErrorResponse"
});
