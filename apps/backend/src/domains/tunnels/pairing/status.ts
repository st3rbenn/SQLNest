/**
 * `getPairingStatus` — résout l'état d'un pairing pour le CLI qui poll
 * ET pour l'UI /connect qui l'utilise pour adapter son flow.
 *
 * Priorités d'évaluation (une fois la row trouvée) :
 *   1. `consumed_at != null`  → `consumed`  (déjà utilisé, CLI doit refaire un connect)
 *   2. `expires_at <= now()`  → `expired`   (TTL dépassé)
 *   3. `approved_at != null`  → `approved`  (le user a autorisé, CLI peut authenticate)
 *   4. sinon                  → `pending`   (attente de l'user)
 *
 * Ordre choisi pour éviter les fausses lectures : un pairing peut être
 * consommé APRÈS expiration (race — le user vient de finir l'auth au
 * moment où le CRON purge). On surface le state final (consumed) plutôt
 * que l'état transitoire (expired).
 *
 * Row absente → `expired` (indistingible d'un code invalide → même UX).
 * Empêche l'énumération de codes existants.
 *
 * ─── `existingConnection` (C.7) ────────────────────────────────────────
 * Si `userId` est fourni (call vient d'un endpoint authentifié via cookie),
 * on lookup le fingerprint du CLI (hash de sa pubkey stockée dans le
 * pairing) contre les db_connections du user. Si match → l'UI /connect
 * saura afficher "Reconnexion à X" au lieu de demander un nom.
 * Sans userId (poll CLI public), toujours `null`.
 */

import { schema as dbSchema } from "@sqlnest/db";
import { and, eq } from "drizzle-orm";
import type { DbOrTx } from "../db";
import { computeCliFingerprint } from "./crypto";
import type { StatusPairingResponseT } from "./schema";

export async function getPairingStatus(
	db: DbOrTx,
	codeCanonical: string,
	options: {
		readonly userId?: string;
		readonly teamId?: string;
		readonly nowMs?: number;
	} = {}
): Promise<StatusPairingResponseT> {
	const nowMs = options.nowMs ?? Date.now();
	const rows = await db
		.select({
			approvedAt: dbSchema.tunnelPairing.approvedAt,
			consumedAt: dbSchema.tunnelPairing.consumedAt,
			expiresAt: dbSchema.tunnelPairing.expiresAt,
			deviceName: dbSchema.tunnelPairing.deviceName,
			cliPubkey: dbSchema.tunnelPairing.cliPubkeyEd25519,
			cliConnectionName: dbSchema.tunnelPairing.cliConnectionName
		})
		.from(dbSchema.tunnelPairing)
		.where(eq(dbSchema.tunnelPairing.code, codeCanonical))
		.limit(1);

	const row = rows[0];
	if (!row) {
		return { status: "expired", deviceName: null, existingConnection: null };
	}

	// Lookup existingConnection quand un user est identifié — fingerprint
	// SCOPÉ par la DSN CLI (C.13) : SHA256(pubkey || "|" || connectionName)
	// si le CLI a envoyé son nom local, sinon fingerprint legacy pubkey-only.
	// C.21.4 : si `teamId` est fourni (route team-scoped), on scope aussi
	// par team_id. Sinon lookup par user_id (legacy).
	let existingConnection: { id: string; name: string } | null = null;
	if (options.userId !== undefined) {
		const fingerprint = computeCliFingerprint(
			row.cliPubkey,
			row.cliConnectionName
		);
		const scopeFilter = options.teamId
			? eq(dbSchema.dbConnection.teamId, options.teamId)
			: eq(dbSchema.dbConnection.userId, options.userId);
		const existing = await db
			.select({
				id: dbSchema.dbConnection.id,
				name: dbSchema.dbConnection.name
			})
			.from(dbSchema.dbConnection)
			.where(
				and(scopeFilter, eq(dbSchema.dbConnection.cliFingerprint, fingerprint))
			)
			.limit(1);
		const match = existing[0];
		if (match) existingConnection = { id: match.id, name: match.name };
	}

	if (row.consumedAt != null) {
		return {
			status: "consumed",
			deviceName: row.deviceName,
			existingConnection
		};
	}
	if (row.expiresAt.getTime() <= nowMs) {
		return {
			status: "expired",
			deviceName: row.deviceName,
			existingConnection
		};
	}
	if (row.approvedAt != null) {
		return {
			status: "approved",
			deviceName: row.deviceName,
			existingConnection
		};
	}
	return { status: "pending", deviceName: null, existingConnection };
}
