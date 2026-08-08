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
import { createPersonalTeam } from "../../teams/create";
import { getDefaultTeamOfUser } from "../../teams/get";
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
	nowMs: number = Date.now(),
	teamIdOverride: string | null = null
): Promise<ApproveResult> {
	// Transaction : le check de collision `db_connection` doit être
	// atomique avec l'UPDATE — sinon 2 approves concurrents pourraient
	// tous deux voir "libre" et créer plus tard 2 db_connections avec le
	// même (team, deviceName) au /authenticate (violation contrainte).
	return db.transaction(async (tx) => {
		const rows = await tx
			.select({
				code: dbSchema.tunnelPairing.code,
				approvedAt: dbSchema.tunnelPairing.approvedAt,
				consumedAt: dbSchema.tunnelPairing.consumedAt,
				expiresAt: dbSchema.tunnelPairing.expiresAt,
				cliPubkey: dbSchema.tunnelPairing.cliPubkeyEd25519,
				cliConnectionName: dbSchema.tunnelPairing.cliConnectionName,
				teamId: dbSchema.tunnelPairing.teamId
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

		// C.21.4 — résout la team dans laquelle la db_connection sera créée
		// à l'authenticate. Priorité :
		//   1) `teamIdOverride` (route team-scoped `/api/teams/:slug/...`)
		//   2) `pairing.teamId` (déjà set par un précédent approve idempotent)
		//   3) team perso de l'user (fallback pour route legacy
		//      `/api/tunnels/pairings/:code/approve`)
		let effectiveTeamId: string;
		if (teamIdOverride) {
			effectiveTeamId = teamIdOverride;
		} else if (row.teamId) {
			effectiveTeamId = row.teamId;
		} else {
			const defaultTeam = await getDefaultTeamOfUser(tx, userId);
			if (defaultTeam) {
				effectiveTeamId = defaultTeam.id;
			} else {
				// Filet lazy — un user qui approuve avant que sa team perso
				// soit créée (race Better Auth hook).
				const created = await createPersonalTeam(tx, userId);
				effectiveTeamId = created.teamId;
			}
		}

		// C.7 — Lookup db_connection existante par fingerprint SCOPÉ (C.13 :
		// SHA256(pubkey || "|" || cliConnectionName)). C.21.4 : on scope par
		// team_id — un même CLI peut exister dans plusieurs teams du user,
		// chacune reconnue indépendamment. Si match dans la team courante,
		// on autofill le deviceName avec le nom existant côté serveur.
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
					eq(dbSchema.dbConnection.teamId, effectiveTeamId),
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

		// Check collision `(team, name)` UNIQUEMENT pour un nouveau CLI —
		// pour un fingerprint existant, on réutilise le nom déjà valide.
		if (!existingConn) {
			const nameCollision = await tx
				.select({ id: dbSchema.dbConnection.id })
				.from(dbSchema.dbConnection)
				.where(
					and(
						eq(dbSchema.dbConnection.teamId, effectiveTeamId),
						eq(dbSchema.dbConnection.name, effectiveDeviceName)
					)
				)
				.limit(1);
			if (nameCollision.length > 0) {
				return { ok: false, reason: "name_conflict" as const };
			}
		}

		// Re-approve possible (même user, même code, avant expi/consume) :
		// idempotent — on écrase `approved_at`, `device_name` et `team_id`.
		// Utile si l'user tape un mauvais nom, corrige, resubmit ; ou
		// change de team via un autre onglet.
		await tx
			.update(dbSchema.tunnelPairing)
			.set({
				userId,
				deviceName: effectiveDeviceName,
				teamId: effectiveTeamId,
				approvedAt: new Date(nowMs)
			})
			.where(eq(dbSchema.tunnelPairing.code, codeCanonical));

		return { ok: true };
	});
}
