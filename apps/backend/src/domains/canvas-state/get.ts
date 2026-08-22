import type { DbOrTx } from "./db";
import { resolveCanvasByConnection } from "./resolve";
import type { CanvasConnectionIdT, CanvasPayloadT } from "./schema";

export interface GetCanvasResult {
	readonly payload: CanvasPayloadT;
	readonly updatedAt: string;
}

/**
 * Lit le canvas d'un utilisateur pour une db_connection donnée.
 *
 * Passe par `resolveCanvasByConnection` qui match dans l'ordre :
 *   1. `(user, team, db_fingerprint)` — même instance DB, autre CLI
 *   2. `(user, team) + checksum ∈ historique` — même dump, autre container
 *   3. `(user, connection_id)` — canvas legacy
 * → `null` si aucun match (le handler HTTP répond 404).
 */
export async function getCanvasState(
	db: DbOrTx,
	userId: string,
	connectionId: CanvasConnectionIdT
): Promise<GetCanvasResult | null> {
	const { canvas } = await resolveCanvasByConnection(db, userId, connectionId);
	if (canvas === null) return null;
	return {
		payload: canvas.payload as CanvasPayloadT,
		updatedAt: canvas.updatedAt.toISOString()
	};
}
