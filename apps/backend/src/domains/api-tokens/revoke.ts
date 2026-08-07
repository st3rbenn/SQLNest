/**
 * `revokeApiToken` — soft-revoke un token par id, scoped au user.
 *
 * Renvoie :
 *   - `true`  : row trouvée + révoquée (ou déjà révoquée — idempotent).
 *   - `false` : id inconnu ou n'appartient pas à ce user.
 *
 * L'isolation user est enforced par la clause WHERE — un attaquant ne
 * peut pas révoquer les tokens d'un autre user, même en connaissant
 * leurs UUIDs (probabilité de trouver un uuid ~ 0, mais defense-in-depth).
 *
 * Idempotence : un DELETE sur un token déjà révoqué renvoie `true` (le
 * state final "révoqué" est le même). L'UI dashboard peut appeler
 * plusieurs fois sans se soucier.
 */

import { schema as dbSchema } from "@sqlnest/db";
import { and, eq } from "drizzle-orm";
import type { DbOrTx } from "../tunnels/db";

export async function revokeApiToken(
	db: DbOrTx,
	userId: string,
	tokenId: string,
	nowMs: number = Date.now()
): Promise<boolean> {
	const updated = await db
		.update(dbSchema.apiToken)
		.set({ revokedAt: new Date(nowMs) })
		.where(
			and(
				eq(dbSchema.apiToken.id, tokenId),
				eq(dbSchema.apiToken.userId, userId)
			)
		)
		.returning({ id: dbSchema.apiToken.id });
	return updated.length > 0;
}
