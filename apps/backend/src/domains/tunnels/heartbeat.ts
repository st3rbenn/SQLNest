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
import { eq, sql } from "drizzle-orm";
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
	} = {
		lastSeenAt: sql`now()`
	};
	if (dbFingerprint !== null) patch.dbFingerprint = dbFingerprint;
	if (dbSchemaChecksum !== null) patch.dbSchemaChecksum = dbSchemaChecksum;

	await db
		.update(dbSchema.dbConnection)
		.set(patch)
		.where(eq(dbSchema.dbConnection.id, session.connectionId));

	return { ok: true, connectionId: session.connectionId };
}
