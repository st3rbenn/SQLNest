/**
 * `listDbConnectionsByTeam` — miroir team-scoped de `listDbConnections`.
 * WHERE team_id = X au lieu de WHERE user_id = X. Utilisé par les
 * routes `/api/teams/:slug/db-connections`. */

import { schema as dbSchema } from "@sqlnest/db";
import { desc, eq } from "drizzle-orm";
import type { DbOrTx } from "../tunnels/db";
import type { DbConnectionSummary } from "./list";

export async function listDbConnectionsByTeam(
	db: DbOrTx,
	teamId: string
): Promise<DbConnectionSummary[]> {
	return db
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
		.where(eq(dbSchema.dbConnection.teamId, teamId))
		.orderBy(desc(dbSchema.dbConnection.activeSince));
}
