/**
 * `listDbConnections` — retourne les `db_connection` du user connecté.
 *
 * ─── Colonnes retournées ──────────────────────────────────────────────
 * Toutes SÛRES à exposer :
 *   - id, name, engine        : identifiants + type de moteur.
 *   - cli_fingerprint         : SHA-256 hex de la pubkey Ed25519 CLI
 *                               (public par nature).
 *   - engine_metadata         : jsonb libre (versions PG, list schemas,
 *                               capacités) — peuplé au ping/introspect.
 *   - active_since, last_seen_at : timestamps d'observabilité.
 *
 * ─── Ordre ────────────────────────────────────────────────────────────
 * `active_since DESC` — le tunnel le plus récent d'abord. L'UI dashboard
 * s'en sert pour surfacer les connections les plus fraîches.
 *
 * ─── Sécurité ─────────────────────────────────────────────────────────
 * `WHERE user_id = X` = isolation stricte. Un attaquant connaissant le
 * `id` d'une connection d'un autre user ne peut pas la lister via cette
 * route.
 */

import { schema as dbSchema } from "@sqlnest/db";
import { desc, eq } from "drizzle-orm";
import type { DbOrTx } from "../tunnels/db";

export interface DbConnectionSummary {
	readonly id: string;
	readonly name: string;
	readonly engine: string;
	readonly cliFingerprint: string;
	readonly engineMetadata: unknown;
	readonly activeSince: Date;
	readonly lastSeenAt: Date | null;
	readonly createdAt: Date;
	/** Snapshot précalculé du dernier rendu de preview. `null` si jamais
	 *  save. Le frontend s'en sert comme fallback rendu quand le CLI est
	 *  offline. Format `PreviewSnapshot` (voir schema Zod). */
	readonly lastPreviewSnapshot: unknown;
}

export async function listDbConnections(
	db: DbOrTx,
	userId: string
): Promise<DbConnectionSummary[]> {
	const rows = await db
		.select({
			id: dbSchema.dbConnection.id,
			name: dbSchema.dbConnection.name,
			engine: dbSchema.dbConnection.engine,
			cliFingerprint: dbSchema.dbConnection.cliFingerprint,
			engineMetadata: dbSchema.dbConnection.engineMetadata,
			activeSince: dbSchema.dbConnection.activeSince,
			lastSeenAt: dbSchema.dbConnection.lastSeenAt,
			createdAt: dbSchema.dbConnection.createdAt,
			lastPreviewSnapshot: dbSchema.dbConnection.lastPreviewSnapshot
		})
		.from(dbSchema.dbConnection)
		.where(eq(dbSchema.dbConnection.userId, userId))
		.orderBy(desc(dbSchema.dbConnection.activeSince));
	return rows;
}
