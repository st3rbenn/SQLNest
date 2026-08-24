import { schema as dbSchema } from "@sqlnest/db";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { resolveCanvasByConnection } from "./resolve";
import type { CanvasConnectionIdT } from "./schema";

export interface DelCanvasResult {
	readonly deleted: boolean;
}

/**
 * Supprime le canvas d'un utilisateur pour une db_connection donnée.
 *
 * Utilise `resolveCanvasByConnection` pour trouver le canvas (via
 * fp/checksum/legacy). ATTENTION : le canvas moderne est partagé entre
 * plusieurs db_connections d'un user (Mac + Windows sur la même DB). Le
 * DELETE supprime le canvas partagé, pas juste la liaison — décision UX :
 * l'user reset son layout, pas juste pour un device. Documenter côté UI.
 *
 * Idempotent (retourne `deleted: false` si aucun canvas).
 */
export async function delCanvasState(
	db: FastifyInstance["db"],
	userId: string,
	connectionId: CanvasConnectionIdT
): Promise<DelCanvasResult> {
	const { canvas } = await resolveCanvasByConnection(db, userId, connectionId);
	if (canvas === null) return { deleted: false };
	const rows = await db
		.delete(dbSchema.canvasState)
		.where(eq(dbSchema.canvasState.id, canvas.id))
		.returning({ id: dbSchema.canvasState.id });
	return { deleted: rows.length > 0 };
}
