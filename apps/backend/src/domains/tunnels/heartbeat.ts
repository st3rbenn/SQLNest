/**
 * `heartbeatTunnel` — le CLI signale un tunnel toujours actif et backfill
 * les métadonnées DB (fingerprint identité, checksum structure).
 *
 * ─── Problème résolu ──────────────────────────────────────────────────
 * `findResumableTunnel` côté CLI skip complètement `/authenticate` si le
 * token local est valide. Résultat : `dbFingerprint` (T4/1) et
 * `dbSchemaChecksum` (T4/2) n'atteignent JAMAIS le backend pour les
 * connexions déjà pair-ées. Ce endpoint résout ça — le CLI l'appelle au
 * boot du serve loop ET périodiquement (à définir côté CLI).
 *
 * ─── Contrat ──────────────────────────────────────────────────────────
 * Auth : Bearer `tn_...` (token clair du tunnel session). Vérifié via
 * `authenticateTunnelSession` — même chemin que le WS handshake.
 *
 * Effets (dans une seule transaction) :
 *   - Bump `db_connection.last_seen_at`.
 *   - Backfill `db_fingerprint` si fourni ET différent de la valeur
 *     actuelle (change détecté = DB restaurée / basculée → log utile v2).
 *   - Backfill `db_schema_checksum` idem.
 *
 * Le token révoqué / expiré → 401 (comme tous les endpoints Bearer).
 * Le token orphelin (db_connection supprimée en cascade) → 401 propre.
 */

import { schema as dbSchema } from "@sqlnest/db";
import { and, eq, sql } from "drizzle-orm";
import { resolveCanvasByConnection } from "../canvas-state/resolve";
import type { DbOrTx } from "./db";
import { authenticateTunnelSession } from "./session/authenticate-tunnel-session";

export type HeartbeatFailureReason = "invalid_token";

export type HeartbeatResult =
	| {
			readonly ok: true;
			readonly connectionId: string;
	  }
	| {
			readonly ok: false;
			readonly reason: HeartbeatFailureReason;
	  };

export async function heartbeatTunnel(
	db: DbOrTx,
	clearToken: string,
	dbFingerprint: string | null = null,
	dbSchemaChecksum: string | null = null,
	engine: "postgres" | "mongodb" | null = null,
	nowMs: number = Date.now()
): Promise<HeartbeatResult> {
	const session = await authenticateTunnelSession(db, clearToken, nowMs);
	if (session === null) {
		return { ok: false, reason: "invalid_token" };
	}

	const patch: {
		lastSeenAt: ReturnType<typeof sql>;
		dbFingerprint?: string;
		dbSchemaChecksum?: string;
		engine?: string;
	} = {
		lastSeenAt: sql`now()`
	};
	if (dbFingerprint !== null) patch.dbFingerprint = dbFingerprint;
	if (dbSchemaChecksum !== null) patch.dbSchemaChecksum = dbSchemaChecksum;
	// PM/10 D8 fix — backfill engine réel du CLI (le pairing initial stocke
	// DEFAULT_ENGINE="postgres" en dur, ne distingue pas Mongo). Le CLI envoie
	// désormais son engine détecté (scheme DSN) via ce heartbeat, on met à
	// jour db_connection.engine en conséquence. Idempotent : chaque heartbeat
	// écrit la valeur, silencieux si déjà correcte.
	if (engine !== null) patch.engine = engine;

	await db
		.update(dbSchema.dbConnection)
		.set(patch)
		.where(eq(dbSchema.dbConnection.id, session.connectionId));

	// T4/4 : si un canvas existe déjà (via lookup fp/checksum/legacy) pour
	// cette db_connection, on APPEND le checksum courant à son historique
	// s'il n'est pas encore présent, puis on log un event audit. Rien à
	// faire si aucun canvas — il sera créé au premier PUT côté frontend
	// avec le checksum initial via put.ts.
	if (dbSchemaChecksum !== null) {
		await appendCanvasChecksum(
			db,
			session.userId,
			session.connectionId,
			dbSchemaChecksum
		);
	}

	return { ok: true, connectionId: session.connectionId };
}

/**
 * T4/4 : append un checksum courant à l'array historique du canvas si
 * absent, puis insert un `canvas_checksum_event` (audit trail). Idempotent
 * sur l'array (pas d'append si le checksum est déjà présent) MAIS log
 * quand même l'event — permet de tracer les heartbeats redondants dans le
 * temps ("le CLI Mac est toujours actif avec checksum X"). Skip si aucun
 * canvas trouvé (le CLI a pair-é mais l'user n'a pas encore ouvert le
 * canvas côté frontend, donc pas de row à append).
 */
async function appendCanvasChecksum(
	db: DbOrTx,
	userId: string,
	connectionId: string,
	checksum: string
): Promise<void> {
	const { canvas } = await resolveCanvasByConnection(db, userId, connectionId);
	if (canvas === null) return;

	// Append si absent. `array_append` retourne un nouveau tableau — on
	// filtre côté WHERE via NOT `= ANY` pour éviter les doublons. Cap à 20
	// entrées via `array_length` : au-delà, on trim le plus vieux (FIFO).
	await db
		.update(dbSchema.canvasState)
		.set({
			dbSchemaChecksums: sql`(
				CASE
					WHEN array_length(${dbSchema.canvasState.dbSchemaChecksums}, 1) >= 20
						THEN array_append(
							${dbSchema.canvasState.dbSchemaChecksums}[2:20],
							${checksum}
						)
					ELSE array_append(${dbSchema.canvasState.dbSchemaChecksums}, ${checksum})
				END
			)`
		})
		.where(
			and(
				eq(dbSchema.canvasState.id, canvas.id),
				sql`NOT (${checksum} = ANY(${dbSchema.canvasState.dbSchemaChecksums}))`
			)
		);

	// Log l'event quel que soit le résultat de l'append (checksum déjà vu
	// = event redondant qui trace le heartbeat).
	await db.insert(dbSchema.canvasChecksumEvent).values({
		canvasStateId: canvas.id,
		dbConnectionId: connectionId,
		dbSchemaChecksum: checksum
	});
}
