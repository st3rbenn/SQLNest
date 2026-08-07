/**
 * `authenticateBearer` — valide un token clair `sn_...` contre la DB.
 *
 * Contrat :
 *   - Prend le clair (post-parse Bearer header par la route).
 *   - SELECT WHERE `hash = SHA256(clear)` AND `revoked_at IS NULL`.
 *   - Si match : bump `last_used_at` (dans la même transaction) et
 *     retourne `{ userId, apiTokenId }`.
 *   - Sinon : `null`.
 *
 * Le bump de `last_used_at` est INCLUS dans la même transaction pour :
 *   1. Éviter les writes concurrents (deux requêtes simultanées pour le
 *      même token — pas grave si le timestamp diverge de quelques ms).
 *   2. Garantir qu'un token révoqué entre le SELECT et l'UPDATE n'est
 *      pas re-validé (SELECT FOR UPDATE bloque l'UPDATE de revocation
 *      concurrent le temps de valider).
 *
 * Nota : sur un token invalide, on ne dévoile PAS s'il correspond à un
 * hash inconnu ou à un token révoqué — la route caller renverra un 401
 * générique.
 */

import { schema as dbSchema } from "@sqlnest/db";
import { and, eq, isNull } from "drizzle-orm";
import type { DbOrTx } from "../tunnels/db";
import { hashApiToken } from "./crypto";

export interface AuthenticateBearerResult {
	readonly userId: string;
	readonly apiTokenId: string;
}

export async function authenticateBearer(
	db: DbOrTx,
	clearToken: string,
	nowMs: number = Date.now()
): Promise<AuthenticateBearerResult | null> {
	const hash = hashApiToken(clearToken);

	return db.transaction(async (tx) => {
		const rows = await tx
			.select({
				id: dbSchema.apiToken.id,
				userId: dbSchema.apiToken.userId
			})
			.from(dbSchema.apiToken)
			.where(
				and(
					eq(dbSchema.apiToken.hash, hash),
					isNull(dbSchema.apiToken.revokedAt)
				)
			)
			.for("update")
			.limit(1);

		const row = rows[0];
		if (!row) return null;

		await tx
			.update(dbSchema.apiToken)
			.set({ lastUsedAt: new Date(nowMs) })
			.where(eq(dbSchema.apiToken.id, row.id));

		return { userId: row.userId, apiTokenId: row.id };
	});
}
