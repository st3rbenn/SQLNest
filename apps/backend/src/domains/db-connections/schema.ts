/**
 * Schémas Zod pour la route `/api/db-connections`.
 */

import z from "zod/v4";

/** Snapshot précalculé d'un rendu de preview. Alimenté par le frontend
 *  au save du canvas, réutilisé côté client pour rendre la preview quand
 *  le CLI est offline (au lieu de "CLI hors ligne"). Léger (~2-10 KB
 *  JSON), theme-agnostic (les couleurs sont calculées au render, pas
 *  stockées).
 *
 *  Bornes : cap 200 nodes / 500 edges / 50 frames pour éviter les
 *  payloads abusifs. Un schéma de plus grande taille est rare en preview
 *  gallery ; au pire, le client tronque.
 */
export const PreviewSnapshotSchema = z.object({
	nodes: z
		.array(
			z.object({
				id: z.string().min(1).max(200),
				x: z.number().finite(),
				y: z.number().finite(),
				w: z.number().finite().positive(),
				h: z.number().finite().positive()
			})
		)
		.max(200),
	edges: z
		.array(
			z.object({
				source: z.string().min(1).max(200),
				target: z.string().min(1).max(200)
			})
		)
		.max(500),
	frames: z
		.array(
			z.object({
				key: z.string().min(1).max(200),
				label: z.string().max(200),
				hue: z.number().int().min(0).max(360),
				x: z.number().finite(),
				y: z.number().finite(),
				w: z.number().finite().positive(),
				h: z.number().finite().positive()
			})
		)
		.max(50)
});
z.globalRegistry.add(PreviewSnapshotSchema, { id: "PreviewSnapshot" });
export type PreviewSnapshotT = z.infer<typeof PreviewSnapshotSchema>;

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
			 *   - afficher un badge "online" dans la gallery
			 *   - auto-refetch le schema quand le CLI reconnecte
			 *     (transition false→true déclenche invalidation cache). */
			isOnline: z.boolean(),
			/** Dernier snapshot de preview persisté. `null` tant que l'user
			 *  n'a pas ouvert le canvas au moins une fois. */
			lastPreviewSnapshot: PreviewSnapshotSchema.nullable()
		})
	)
});
z.globalRegistry.add(ListDbConnectionsResponse, {
	id: "ListDbConnectionsResponse"
});
export type ListDbConnectionsResponseT = z.infer<
	typeof ListDbConnectionsResponse
>;

// ─── PUT /api/db-connections/:id/preview-snapshot ─────────────────────
export const PutPreviewSnapshotBody = z.object({
	snapshot: PreviewSnapshotSchema
});
z.globalRegistry.add(PutPreviewSnapshotBody, { id: "PutPreviewSnapshotBody" });
export type PutPreviewSnapshotBodyT = z.infer<typeof PutPreviewSnapshotBody>;

export const PutPreviewSnapshotResponse = z.object({
	ok: z.literal(true)
});
z.globalRegistry.add(PutPreviewSnapshotResponse, {
	id: "PutPreviewSnapshotResponse"
});

export const ConnectionIdParams = z.object({ id: z.string().uuid() });
z.globalRegistry.add(ConnectionIdParams, { id: "ConnectionIdParams" });
export type ConnectionIdParamsT = z.infer<typeof ConnectionIdParams>;

export const DbConnectionsErrorResponse = z.object({ message: z.string() });
z.globalRegistry.add(DbConnectionsErrorResponse, {
	id: "DbConnectionsErrorResponse"
});
