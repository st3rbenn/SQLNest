import { schema as dbSchema } from "@sqlnest/db";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { CanvasConnectionIdT } from "./schema";

export interface DelCanvasResult {
	readonly deleted: boolean;
}

/**
 * Supprime le canvas d'un utilisateur pour une db_connection donnée.
 *
 * ─── Contrat ───────────────────────────────────────────────────────────
 * Retourne `{ deleted: true }` si une row a été supprimée, `false` sinon.
 * L'appelant HTTP renvoie 204 dans les deux cas (idempotent : deleting a
 * non-existent resource ne doit pas être une erreur — le résultat final
 * est le même : la ressource n'existe pas).
 *
 * Le `RETURNING id` permet de savoir combien de rows ont été affectées
 * sans re-compter (Drizzle expose `rowCount` sur certains dialects mais
 * pas de façon uniforme via `postgres.js` → `.returning()` reste le plus
 * portable).
 */
export async function delCanvasState(
	db: FastifyInstance["db"],
	userId: string,
	connectionId: CanvasConnectionIdT
): Promise<DelCanvasResult> {
	const rows = await db
		.delete(dbSchema.canvasState)
		.where(
			and(
				eq(dbSchema.canvasState.userId, userId),
				eq(dbSchema.canvasState.connectionId, connectionId)
			)
		)
		.returning({ id: dbSchema.canvasState.id });

	return { deleted: rows.length > 0 };
}
