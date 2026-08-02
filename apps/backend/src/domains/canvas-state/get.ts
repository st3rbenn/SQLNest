import { schema as dbSchema } from "@sqlnest/db";
import { and, eq } from "drizzle-orm";
import type { DbOrTx } from "./db";
import type { CanvasPayloadT, CanvasSignatureT } from "./schema";

export interface GetCanvasResult {
	readonly payload: CanvasPayloadT;
	readonly updatedAt: string;
}

/**
 * Lit le canvas d'un utilisateur pour une signature de schéma donnée.
 *
 * ─── Contrat ───────────────────────────────────────────────────────────
 * - `null` si aucune row (userId × signature) — le handler HTTP répondra 404.
 * - `{ payload, updatedAt }` sinon.
 *
 * L'unique-index (`user_id`, `schema_signature`) garantit qu'au plus une
 * row existe pour un couple donné — on utilise `LIMIT 1` pour rester
 * explicite (defensive : si l'index disparaissait, on ne renverrait pas
 * plusieurs rows silencieusement).
 */
export async function getCanvasState(
	db: DbOrTx,
	userId: string,
	signature: CanvasSignatureT
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
				eq(dbSchema.canvasState.schemaSignature, signature)
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
