/**
 * `authenticatePairing` — le CLI finalise le device flow.
 *
 * Contrat :
 *   - Le pairing doit être `approved` (user a validé), non-expiré,
 *     non-consumed.
 *   - Le CLI présente une **signature Ed25519 du code canonique** par la
 *     privkey correspondant à la `cli_pubkey_ed25519` inscrite dans le
 *     pairing. Sans la privkey, un attaquant qui a intercepté le code
 *     ne peut pas s'authentifier.
 *
 * Effets (dans une seule transaction) :
 *   1. `SELECT ... FOR UPDATE` du pairing (row lock).
 *   2. Vérif Ed25519 sur le code canonique.
 *   3. INSERT `db_connection` (`user_id`, `name = device_name`,
 *      `cli_fingerprint = SHA256(pubkey)`, `engine = "postgres"`).
 *   4. Generate `token = tn_<hex>` + hash. INSERT `tunnel_session`
 *      (`connection_id`, `hash`, `expires_at = now + 30j`).
 *   5. `UPDATE tunnel_pairing SET consumed_at = now()`.
 *   6. Retourne `{ token, tunnelId, connectionId, expiresAt }` — le token
 *      clair est renvoyé UNE seule fois au CLI, jamais persisté.
 *
 * Erreurs → discriminated union, jamais d'exception (facile à mapper vers
 * un status HTTP côté route).
 */

import { schema as dbSchema } from "@sqlnest/db";
import { eq } from "drizzle-orm";
import { upsertDbConnectionByFingerprint } from "../../db-connections/upsert";
import type { DbOrTx } from "../db";
import { generateSessionToken, hashSha256Hex, verifyEd25519 } from "./crypto";

/** Engine par défaut à la première authentification. Le CLI pourra
 * changer via le dashboard (Bloc 11) ou une future commande CLI. */
const DEFAULT_ENGINE = "postgres";

/** Durée de vie d'une session tunnel — 30 jours. Cohérent avec un
 * usage "installation permanente" du CLI (contrairement à une session
 * browser). Le CLI peut renouveler manuellement via `sqlnest reauth`. */
export const TUNNEL_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type AuthenticateFailureReason =
	| "not_found"
	| "expired"
	| "already_used"
	| "not_approved"
	| "signature_invalid";

export type AuthenticateResult =
	| {
			readonly ok: true;
			readonly token: string;
			readonly tunnelId: string;
			readonly connectionId: string;
			readonly expiresAt: Date;
	  }
	| {
			readonly ok: false;
			readonly reason: AuthenticateFailureReason;
	  };

export async function authenticatePairing(
	db: DbOrTx,
	codeCanonical: string,
	signatureHex: string,
	nowMs: number = Date.now()
): Promise<AuthenticateResult> {
	return db.transaction(async (tx) => {
		const rows = await tx
			.select({
				userId: dbSchema.tunnelPairing.userId,
				cliPubkey: dbSchema.tunnelPairing.cliPubkeyEd25519,
				cliConnectionName: dbSchema.tunnelPairing.cliConnectionName,
				deviceName: dbSchema.tunnelPairing.deviceName,
				approvedAt: dbSchema.tunnelPairing.approvedAt,
				consumedAt: dbSchema.tunnelPairing.consumedAt,
				expiresAt: dbSchema.tunnelPairing.expiresAt
			})
			.from(dbSchema.tunnelPairing)
			.where(eq(dbSchema.tunnelPairing.code, codeCanonical))
			.for("update")
			.limit(1);

		const row = rows[0];
		if (!row) return { ok: false, reason: "not_found" as const };
		if (row.consumedAt != null) {
			return { ok: false, reason: "already_used" as const };
		}
		if (row.expiresAt.getTime() <= nowMs) {
			return { ok: false, reason: "expired" as const };
		}
		if (
			row.approvedAt == null ||
			row.userId == null ||
			row.deviceName == null
		) {
			return { ok: false, reason: "not_approved" as const };
		}

		if (!verifyEd25519(codeCanonical, signatureHex, row.cliPubkey)) {
			return { ok: false, reason: "signature_invalid" as const };
		}

		// Pairing idempotent (C.6/C.13) : le fingerprint est SCOPÉ par la
		// DSN locale du CLI (C.13) → un même install CLI peut avoir N
		// db_connection distinctes, chacune identifiée par sa DSN locale.
		// Si `(user_id, cli_fingerprint)` existe déjà → RÉUTILISE. Sinon
		// INSERT normal.
		const upsert = await upsertDbConnectionByFingerprint(tx, {
			userId: row.userId,
			cliPubkey: row.cliPubkey,
			cliConnectionName: row.cliConnectionName,
			name: row.deviceName,
			engine: DEFAULT_ENGINE
		});
		if (!upsert.ok) {
			// Cas rarissime : l'user a approuvé un name qui vient d'être
			// utilisé par un autre CLI entre l'approve et l'authenticate.
			// On log comme signature_invalid par manque de raison dédiée ;
			// à V2 on ajoutera un `name_conflict` explicite dans l'union.
			return { ok: false, reason: "signature_invalid" as const };
		}
		const conn = { id: upsert.connectionId };

		const token = generateSessionToken();
		const tokenHash = hashSha256Hex(token);
		const expiresAt = new Date(nowMs + TUNNEL_SESSION_TTL_MS);

		const insertedSession = await tx
			.insert(dbSchema.tunnelSession)
			.values({
				connectionId: conn.id,
				hash: tokenHash,
				expiresAt
			})
			.returning({ id: dbSchema.tunnelSession.id });

		const sess = insertedSession[0];
		if (!sess) {
			throw new Error(
				"authenticatePairing: INSERT tunnel_session n'a rien renvoyé"
			);
		}

		await tx
			.update(dbSchema.tunnelPairing)
			.set({ consumedAt: new Date(nowMs) })
			.where(eq(dbSchema.tunnelPairing.code, codeCanonical));

		return {
			ok: true,
			token,
			tunnelId: sess.id,
			connectionId: conn.id,
			expiresAt
		};
	});
}
