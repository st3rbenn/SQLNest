/**
 * `approvePairing` — le user authentifié autorise un pairing pending.
 *
 * Contrats :
 *   - Le user DOIT être connecté (l'appelant vérifie via `requireUser`).
 *   - Le code DOIT être valide, pending, non-expiré, et non-consumed.
 *   - `deviceName` est **optionnel** depuis C.7 :
 *       * Si le fingerprint du CLI matche une `db_connection` existante
 *         du user (pairing idempotent) → on autofill avec le nom existant.
 *         Le `deviceName` fourni (s'il l'est) est ignoré silencieusement
 *         puisqu'il est ALIGNÉ avec ce que fera l'upsert au /authenticate.
 *       * Sinon : `deviceName` est REQUIS et doit être unique parmi les
 *         `db_connection` du user.
 *
 * Renvoie un discriminated union :
 *   - `{ ok: true }` : pairing lié au user, waiting pour /authenticate.
 *   - `{ ok: false, reason }` : détail pour l'UI.
 */

import { schema as dbSchema } from "@sqlnest/db";
import { and, eq } from "drizzle-orm";
import type { DbOrTx } from "../db";
import { computeCliFingerprint } from "./crypto";

export type ApproveFailureReason =
	| "not_found"
	| "expired"
	| "already_used"
	| "name_conflict"
	| "name_required";

export type ApproveResult =
	| { readonly ok: true }
	| { readonly ok: false; readonly reason: ApproveFailureReason };

export async function approvePairing(
	db: DbOrTx,
	codeCanonical: string,
	userId: string,
	deviceName: string | undefined,
	nowMs: number = Date.now()
): Promise<ApproveResult> {
	// Transaction : le check de collision `db_connection` doit être
	// atomique avec l'UPDATE — sinon 2 approves concurrents pourraient
	// tous deux voir "libre" et créer plus tard 2 db_connections avec le
	// même (user_id, deviceName) au /authenticate (violation contrainte).
	return db.transaction(async (tx) => {
		const rows = await tx
			.select({
				code: dbSchema.tunnelPairing.code,
				approvedAt: dbSchema.tunnelPairing.approvedAt,
				consumedAt: dbSchema.tunnelPairing.consumedAt,
				expiresAt: dbSchema.tunnelPairing.expiresAt,
				cliPubkey: dbSchema.tunnelPairing.cliPubkeyEd25519,
				cliConnectionName: dbSchema.tunnelPairing.cliConnectionName
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

		// C.7 — Lookup db_connection existante par fingerprint SCOPÉ (C.13 :
		// SHA256(pubkey || "|" || cliConnectionName) si le CLI a envoyé son
		// nom local, sinon legacy pubkey-only). Si match, on autofill le
		// deviceName avec le nom existant côté serveur.
		const fingerprint = computeCliFingerprint(
			row.cliPubkey,
			row.cliConnectionName
		);
		const existing = await tx
			.select({
				id: dbSchema.dbConnection.id,
				name: dbSchema.dbConnection.name
			})
			.from(dbSchema.dbConnection)
			.where(
				and(
					eq(dbSchema.dbConnection.userId, userId),
					eq(dbSchema.dbConnection.cliFingerprint, fingerprint)
				)
			)
			.limit(1);
		const existingConn = existing[0];
		const effectiveDeviceName = existingConn?.name ?? deviceName;

		if (!effectiveDeviceName) {
			// Nouveau CLI ET l'user n'a pas saisi de nom : l'UI /connect
			// aurait dû rendre le champ requis. Ce reason permet à un caller
			// robuste (CI script qui bypass l'UI) de comprendre l'erreur.
			return { ok: false, reason: "name_required" as const };
		}

		// Check collision `(user, name)` UNIQUEMENT pour un nouveau CLI —
		// pour un fingerprint existant, on réutilise le nom déjà valide.
		if (!existingConn) {
			const nameCollision = await tx
				.select({ id: dbSchema.dbConnection.id })
				.from(dbSchema.dbConnection)
				.where(
					and(
						eq(dbSchema.dbConnection.userId, userId),
						eq(dbSchema.dbConnection.name, effectiveDeviceName)
					)
				)
				.limit(1);
			if (nameCollision.length > 0) {
				return { ok: false, reason: "name_conflict" as const };
			}
		}

		// Re-approve possible (même user, même code, avant expi/consume) :
		// idempotent — on écrase `approved_at` et `device_name`. Utile si
		// l'user tape un mauvais nom, corrige, resubmit.
		await tx
			.update(dbSchema.tunnelPairing)
			.set({
				userId,
				deviceName: effectiveDeviceName,
				approvedAt: new Date(nowMs)
			})
			.where(eq(dbSchema.tunnelPairing.code, codeCanonical));

		return { ok: true };
	});
}
