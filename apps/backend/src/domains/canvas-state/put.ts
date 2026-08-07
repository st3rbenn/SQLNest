import { schema as dbSchema } from "@sqlnest/db";
import { sql } from "drizzle-orm";
import type { DbOrTx } from "./db";
import type { CanvasConnectionIdT, CanvasPayloadT } from "./schema";

export interface PutCanvasResult {
	readonly updatedAt: string;
}

/**
 * Upsert du canvas d'un utilisateur pour une db_connection donnée.
 *
 * ─── Contrat ───────────────────────────────────────────────────────────
 * - Si (userId, connectionId) n'existe pas → INSERT et renvoie l'updatedAt
 *   posé par le default `now()`.
 * - Si la row existe → UPDATE `payload` + refresh `updated_at = now()` et
 *   renvoie le nouvel updatedAt.
 *
 * On utilise `onConflictDoUpdate` sur l'index unique
 * `canvas_user_connection_unique` (target: userId + connectionId). Ça
 * garantit l'atomicité (pas de race condition SELECT-then-INSERT/UPDATE)
 * et un seul aller-retour DB.
 *
 * ─── updated_at ─────────────────────────────────────────────────────────
 * Sur UPDATE, Postgres ne re-calcule PAS le default `now()` — il faut
 * l'assigner explicitement dans `set`. Sans ça, le champ garderait la
 * valeur d'origine du premier INSERT et le frontend n'aurait aucun moyen
 * de détecter qu'une écriture concurrente a eu lieu (utile plus tard pour
 * un mécanisme de version optimiste).
 */
export async function putCanvasState(
	db: DbOrTx,
	userId: string,
	connectionId: CanvasConnectionIdT,
	payload: CanvasPayloadT
): Promise<PutCanvasResult> {
	const rows = await db
		.insert(dbSchema.canvasState)
		.values({
			userId,
			connectionId,
			payload
		})
		.onConflictDoUpdate({
			target: [
				dbSchema.canvasState.userId,
				dbSchema.canvasState.connectionId
			],
			set: {
				payload,
				updatedAt: sql`now()`
			}
		})
		.returning({ updatedAt: dbSchema.canvasState.updatedAt });

	const row = rows[0];
	if (!row) {
		// Défensif : `RETURNING` sur INSERT/UPDATE Postgres renvoie toujours
		// une row en cas de succès. Si on tombe ici, quelque chose a été
		// vraiment cassé — préférable de crasher fort plutôt que de renvoyer
		// un état incohérent au frontend.
		throw new Error("putCanvasState: upsert n'a rien renvoyé");
	}

	return { updatedAt: row.updatedAt.toISOString() };
}
