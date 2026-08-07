/**
 * `authenticateTunnelSession` — valide un token clair `tn_...` présenté
 * par le CLI (ou le browser) au moment d'ouvrir un WS `/api/tunnels/:tunnelId`.
 *
 * ─── Contrat ──────────────────────────────────────────────────────────
 *   - Prend le clair (post-parse Bearer / query token).
 *   - Cherche `WHERE hash = SHA256(clear) AND revoked_at IS NULL AND
 *     expires_at > now()`.
 *   - Sur match : bump `last_used_at` dans la même transaction et
 *     retourne `{ sessionId, connectionId, userId, cliPubkeyEd25519 }`.
 *   - Sinon `null`.
 *
 * ─── Similaire à `authenticate-bearer` ────────────────────────────────
 * `api-tokens/authenticate-bearer.ts` valide un token `sn_...` (api_token).
 * Ce module valide un token `tn_...` (tunnel_session). Le pattern est
 * identique — SELECT hashé + FOR UPDATE + bump last_used. Une éventuelle
 * factorisation viendra si un 3e cas apparaît.
 *
 * ─── Enrichissement de la row ─────────────────────────────────────────
 * On join la table `db_connection` pour récupérer le `cli_fingerprint`
 * (SHA-256 de la pubkey Ed25519 du CLI). Le WS handshake vérifie que la
 * pubkey annoncée par le CLI hashe bien vers ce fingerprint — sinon
 * refus.
 */

import { schema as dbSchema } from "@sqlnest/db";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import type { DbOrTx } from "../db";
import { hashSha256Hex } from "../pairing/crypto";

export interface AuthenticateTunnelSessionResult {
	readonly sessionId: string;
	readonly connectionId: string;
	readonly userId: string;
	/** SHA-256 hex de la pubkey Ed25519 du CLI qui a créé la connection.
	 *  Le WS handshake CLI DOIT annoncer une pubkey dont le hash matche. */
	readonly cliFingerprint: string;
}

export async function authenticateTunnelSession(
	db: DbOrTx,
	clearToken: string,
	nowMs: number = Date.now()
): Promise<AuthenticateTunnelSessionResult | null> {
	const hash = hashSha256Hex(clearToken);

	return db.transaction(async (tx) => {
		const rows = await tx
			.select({
				sessionId: dbSchema.tunnelSession.id,
				connectionId: dbSchema.tunnelSession.connectionId,
				userId: dbSchema.dbConnection.userId,
				cliFingerprint: dbSchema.dbConnection.cliFingerprint
			})
			.from(dbSchema.tunnelSession)
			.innerJoin(
				dbSchema.dbConnection,
				eq(dbSchema.tunnelSession.connectionId, dbSchema.dbConnection.id)
			)
			.where(
				and(
					eq(dbSchema.tunnelSession.hash, hash),
					isNull(dbSchema.tunnelSession.revokedAt),
					gt(
						dbSchema.tunnelSession.expiresAt,
						sql`to_timestamp(${nowMs / 1000})`
					)
				)
			)
			.for("update")
			.limit(1);

		const row = rows[0];
		if (!row) return null;

		await tx
			.update(dbSchema.tunnelSession)
			.set({ lastUsedAt: new Date(nowMs) })
			.where(eq(dbSchema.tunnelSession.id, row.sessionId));

		return {
			sessionId: row.sessionId,
			connectionId: row.connectionId,
			userId: row.userId,
			cliFingerprint: row.cliFingerprint
		};
	});
}
