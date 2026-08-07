import { schema as dbSchema } from "@sqlnest/db";
import { and, eq } from "drizzle-orm";
import type { DbOrTx } from "./db";
import type { CanvasConnectionIdT, CanvasPayloadT } from "./schema";

export interface GetCanvasResult {
	readonly payload: CanvasPayloadT;
	readonly updatedAt: string;
}

/**
 * Lit le canvas d'un utilisateur pour une db_connection donnée.
 *
 * ─── Contrat ───────────────────────────────────────────────────────────
 * - `null` si aucune row (userId × connectionId) — le handler HTTP répondra 404.
 * - `{ payload, updatedAt }` sinon.
 *
 * L'unique-index (`user_id`, `db_connection_id`) garantit qu'au plus une
 * row existe pour un couple donné — on utilise `LIMIT 1` pour rester
 * explicite (defensive : si l'index disparaissait, on ne renverrait pas
 * plusieurs rows silencieusement).
 */
export async function getCanvasState(
	db: DbOrTx,
	userId: string,
	connectionId: CanvasConnectionIdT
): Promise<GetCanvasResult | null> {
	const rows = await db
		.select({
			payload: dbSchema.canvasState.payload,
			updatedAt: dbSchema.canvasState.updatedAt
		})
		.from(dbSchema.canvasState)
		.where(
			and(
				eq(dbSchema.canvasState.userId, userId),
				eq(dbSchema.canvasState.connectionId, connectionId)
			)
		)
		.limit(1);

	const row = rows[0];
	if (!row) return null;

	return {
		payload: row.payload as CanvasPayloadT,
		updatedAt: row.updatedAt.toISOString()
	};
}
