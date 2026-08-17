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
				teamId: dbSchema.tunnelPairing.teamId,
				dbFingerprint: dbSchema.tunnelPairing.dbFingerprint,
				dbSchemaChecksum: dbSchema.tunnelPairing.dbSchemaChecksum
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

		// Lookup db_connection existante — 3 stratégies pour autofill le
		// deviceName :
		//   1) T4/5 : match (team, db_fingerprint) — MÊME instance DB déjà
		//      pair-ée par un autre CLI (backup/restore ou re-attach).
		//   2) T4/5 fallback : match (team, db_schema_checksum) — cross-docker,
		//      2 dumps identiques dans 2 containers PG distincts.
		//   3) C.7 : match (team, cli_fingerprint) — même CLI re-pair idempotent.
		const fingerprint = computeCliFingerprint(
			row.cliPubkey,
			row.cliConnectionName
		);
		let existingConn: { id: string; name: string } | undefined;
		if (row.dbFingerprint !== null) {
			const dbFpMatch = await tx
				.select({
					id: dbSchema.dbConnection.id,
					name: dbSchema.dbConnection.name
				})
				.from(dbSchema.dbConnection)
				.where(
					and(
						eq(dbSchema.dbConnection.teamId, effectiveTeamId),
						eq(dbSchema.dbConnection.dbFingerprint, row.dbFingerprint)
					)
				)
				.limit(1);
			if (dbFpMatch[0]) existingConn = dbFpMatch[0];
		}
		if (existingConn === undefined && row.dbSchemaChecksum !== null) {
			const csMatch = await tx
				.select({
					id: dbSchema.dbConnection.id,
					name: dbSchema.dbConnection.name
				})
				.from(dbSchema.dbConnection)
				.where(
					and(
						eq(dbSchema.dbConnection.teamId, effectiveTeamId),
						eq(dbSchema.dbConnection.dbSchemaChecksum, row.dbSchemaChecksum)
					)
				)
				.limit(1);
			if (csMatch[0]) existingConn = csMatch[0];
		}
		if (existingConn === undefined) {
			const cliMatch = await tx
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
			if (cliMatch[0]) existingConn = cliMatch[0];
		}
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
