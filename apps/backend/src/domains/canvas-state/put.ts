import { schema as dbSchema } from "@sqlnest/db";
import { eq, sql } from "drizzle-orm";
import type { DbOrTx } from "./db";
import { resolveCanvasByConnection } from "./resolve";
import type { CanvasConnectionIdT, CanvasPayloadT } from "./schema";

export interface PutCanvasResult {
	readonly updatedAt: string;
}

/**
 * Upsert du canvas d'un utilisateur pour une db_connection donnée.
 *
 * ─── T4/4 : refactor cross-device ────────────────────────────────────
 * Le canvas peut déjà exister ailleurs (autre db_connection du user
 * pointant vers la même instance DB). `resolveCanvasByConnection` fait le
 * lookup fingerprint > checksum > legacy → si trouvé, UPDATE ce canvas
 * (peu importe la connection_id d'origine). Sinon INSERT nouveau avec
 * team_id + fp + checksum courant.
 *
 * ─── Concurrence ─────────────────────────────────────────────────────
 * Contrairement à l'ancien `onConflictDoUpdate` sur `(user, connection_id)`,
 * on fait un lookup+write en 2 requêtes. Une race window minime existe
 * entre les 2 : 2 puts concurrents pour la MÊME (user, team, fp) peuvent
 * tomber sur le path INSERT en parallèle et l'un lève `unique_violation`.
 * Le handler HTTP retry naturellement (le client réémet le PUT). En
 * pratique la race est rare (2 devices écrivent le canvas au même
 * moment).
 */
export async function putCanvasState(
	db: DbOrTx,
	userId: string,
	connectionId: CanvasConnectionIdT,
	payload: CanvasPayloadT
): Promise<PutCanvasResult> {
	const { canvas, connection } = await resolveCanvasByConnection(
		db,
		userId,
		connectionId
	);
	if (connection === null) {
		// La db_connection n'existe pas — le handler HTTP devrait 404 avant.
		// Défensif : throw pour signaler un flow cassé (le caller a laissé
		// passer un connectionId invalide).
		throw new Error(
			`putCanvasState: db_connection '${connectionId}' introuvable`
		);
	}

	if (canvas !== null) {
		// UPDATE : le payload change, le reste (team, fp, checksums) reste
		// aligné avec ce qui a été résolu. Si le CLI apporte un checksum
		// nouveau non encore dans l'array, il est ajouté par le heartbeat/
		// authenticate — pas ici (le put est côté frontend, sans checksum).
		const rows = await db
			.update(dbSchema.canvasState)
			.set({ payload, updatedAt: sql`now()` })
			.where(eq(dbSchema.canvasState.id, canvas.id))
			.returning({ updatedAt: dbSchema.canvasState.updatedAt });
		const row = rows[0];
		if (!row) {
			throw new Error("putCanvasState: UPDATE n'a rien renvoyé");
		}
		return { updatedAt: row.updatedAt.toISOString() };
	}

	// INSERT nouveau canvas. On aligne fp + checksums avec la connection
	// pour que les prochains puts (depuis n'importe quel autre CLI sur la
	// même DB) résolvent au même canvas via priorité 1 ou 2.
	const rows = await db
		.insert(dbSchema.canvasState)
		.values({
			userId,
			connectionId,
			teamId: connection.teamId,
			// dbFingerprint nullable si le CLI legacy n'a pas encore backfillé.
			...(connection.dbFingerprint !== null
				? { dbFingerprint: connection.dbFingerprint }
				: {}),
			// Checksum courant → seed l'historique.
			...(connection.dbSchemaChecksum !== null
				? { dbSchemaChecksums: [connection.dbSchemaChecksum] }
				: {}),
			payload
		})
		.returning({ updatedAt: dbSchema.canvasState.updatedAt });
	const row = rows[0];
	if (!row) {
		throw new Error("putCanvasState: INSERT n'a rien renvoyé");
	}
	return { updatedAt: row.updatedAt.toISOString() };
}
