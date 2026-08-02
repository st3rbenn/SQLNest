import { schema as dbSchema } from "@sqlnest/db";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { CanvasPayloadT, CanvasSignatureT } from "./schema";

export interface PutCanvasResult {
	readonly updatedAt: string;
}

/**
 * Upsert du canvas d'un utilisateur pour une signature donnée.
 *
 * ─── Contrat ───────────────────────────────────────────────────────────
 * - Si (userId, signature) n'existe pas → INSERT et renvoie l'updatedAt
 *   posé par le default `now()`.
 * - Si la row existe → UPDATE `payload` + refresh `updated_at = now()` et
 *   renvoie le nouvel updatedAt.
 *
 * On utilise `onConflictDoUpdate` sur l'index unique `canvas_user_schema_unique`
 * (target: userId + schemaSignature). Ça garantit l'atomicité (pas de
 * race condition SELECT-then-INSERT/UPDATE) et un seul aller-retour DB.
 *
 * ─── updated_at ─────────────────────────────────────────────────────────
 * Sur UPDATE, Postgres ne re-calcule PAS le default `now()` — il faut
 * l'assigner explicitement dans `set`. Sans ça, le champ garderait la
 * valeur d'origine du premier INSERT et le frontend n'aurait aucun moyen
 * de détecter qu'une écriture concurrente a eu lieu (utile plus tard pour
 * un mécanisme de version optimiste).
 */
export async function putCanvasState(
	db: FastifyInstance["db"],
	userId: string,
	signature: CanvasSignatureT,
	payload: CanvasPayloadT
): Promise<PutCanvasResult> {
	const rows = await db
		.insert(dbSchema.canvasState)
		.values({
			userId,
			schemaSignature: signature,
			payload
		})
		.onConflictDoUpdate({
			target: [
				dbSchema.canvasState.userId,
				dbSchema.canvasState.schemaSignature
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
