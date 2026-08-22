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
 * `existingConnection` : si `userId` est fourni (call vient d'un endpoint
 * authentifié via cookie), on lookup le fingerprint du CLI (hash de sa
 * pubkey stockée dans le pairing) contre les db_connections du user. Si
 * match → l'UI /connect saura afficher "Reconnexion à X" au lieu de
 * demander un nom. Sans userId (poll CLI public), toujours `null`.
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
			cliConnectionName: dbSchema.tunnelPairing.cliConnectionName,
			dbFingerprint: dbSchema.tunnelPairing.dbFingerprint,
			dbSchemaChecksum: dbSchema.tunnelPairing.dbSchemaChecksum
		})
		.from(dbSchema.tunnelPairing)
		.where(eq(dbSchema.tunnelPairing.code, codeCanonical))
		.limit(1);

	const row = rows[0];
	if (!row) {
		return { status: "expired", deviceName: null, existingConnection: null };
	}

	// Lookup existingConnection quand un user est identifié. Trois stratégies :
	//  1) Le CLI a envoyé un db_fingerprint dès le POST /pairings : match
	//     (team, db_fingerprint). Instance stricte (system_id PG).
	//  2) Fallback : match (team, db_schema_checksum). Cross-docker (2 dumps
	//     identiques ont même checksum mais fingerprints différents).
	//  3) Legacy — fingerprint scopé CLI (SHA256(pubkey|connectionName)) :
	//     un même CLI qui re-pair sur le MÊME nom local → autofill du name.
	// Scope par team_id si fourni, sinon user_id (legacy).
	let existingConnection: { id: string; name: string } | null = null;
	if (options.userId !== undefined) {
		const scopeFilter = options.teamId
			? eq(dbSchema.dbConnection.teamId, options.teamId)
			: eq(dbSchema.dbConnection.userId, options.userId);
		// Priorité 1 : lookup par db_fingerprint (match instance).
		if (row.dbFingerprint !== null) {
			const dbFpMatch = await db
				.select({
					id: dbSchema.dbConnection.id,
					name: dbSchema.dbConnection.name
				})
				.from(dbSchema.dbConnection)
				.where(
					and(
						scopeFilter,
						eq(dbSchema.dbConnection.dbFingerprint, row.dbFingerprint)
					)
				)
				.limit(1);
			if (dbFpMatch[0]) {
				existingConnection = { id: dbFpMatch[0].id, name: dbFpMatch[0].name };
			}
		}
		// Priorité 2 : lookup par db_schema_checksum (match cross-docker).
		if (existingConnection === null && row.dbSchemaChecksum !== null) {
			const csMatch = await db
				.select({
					id: dbSchema.dbConnection.id,
					name: dbSchema.dbConnection.name
				})
				.from(dbSchema.dbConnection)
				.where(
					and(
						scopeFilter,
						eq(dbSchema.dbConnection.dbSchemaChecksum, row.dbSchemaChecksum)
					)
				)
				.limit(1);
			if (csMatch[0]) {
				existingConnection = { id: csMatch[0].id, name: csMatch[0].name };
			}
		}
		// Priorité 3 : lookup par cli_fingerprint (idempotent re-pair même CLI).
		if (existingConnection === null) {
			const fingerprint = computeCliFingerprint(
				row.cliPubkey,
				row.cliConnectionName
			);
			const cliMatch = await db
				.select({
					id: dbSchema.dbConnection.id,
					name: dbSchema.dbConnection.name
				})
				.from(dbSchema.dbConnection)
				.where(
					and(
						scopeFilter,
						eq(dbSchema.dbConnection.cliFingerprint, fingerprint)
					)
				)
				.limit(1);
			if (cliMatch[0]) {
				existingConnection = { id: cliMatch[0].id, name: cliMatch[0].name };
			}
		}
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
