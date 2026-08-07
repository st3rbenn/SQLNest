/**
 * `listApiTokens` — retourne tous les tokens d'un user (actifs et révoqués).
 *
 * Ordre : `created_at DESC` — les plus récents en tête. L'UI dashboard
 * peut filtrer les révoqués côté client si besoin (MVP : on affiche tout).
 *
 * Pas de pagination pour l'instant — un user aura typiquement <20 tokens.
 * Si un jour ça devient un scale problem, on ajoutera `limit`/`offset`
 * mais ce n'est pas MVP.
 */

import { schema as dbSchema } from "@sqlnest/db";
import { desc, eq } from "drizzle-orm";
import type { DbOrTx } from "../tunnels/db";

export interface ApiTokenSummary {
	readonly id: string;
	readonly name: string;
	readonly prefix: string;
	readonly createdAt: Date;
	readonly lastUsedAt: Date | null;
	readonly revokedAt: Date | null;
}

export async function listApiTokens(
	db: DbOrTx,
	userId: string
): Promise<ApiTokenSummary[]> {
	const rows = await db
		.select({
			id: dbSchema.apiToken.id,
			name: dbSchema.apiToken.name,
			prefix: dbSchema.apiToken.prefix,
			createdAt: dbSchema.apiToken.createdAt,
			lastUsedAt: dbSchema.apiToken.lastUsedAt,
			revokedAt: dbSchema.apiToken.revokedAt
		})
		.from(dbSchema.apiToken)
		.where(eq(dbSchema.apiToken.userId, userId))
		.orderBy(desc(dbSchema.apiToken.createdAt));
	return rows;
}
