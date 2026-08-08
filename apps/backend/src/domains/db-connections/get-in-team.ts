/**
 * `assertConnectionInTeam` — vérifie qu'une `db_connection` appartient
 * à la team courante. Utilisé par les routes team-scoped avant d'agir
 * sur la connection (proxy schema/query, preview-snapshot, canvas
 * state). Renvoie `true` si la connection existe ET appartient à la
 * team, `false` sinon (404 côté route, jamais 403 pour éviter la
 * fuite d'existence).
 */

import { schema as dbSchema } from "@sqlnest/db";
import { and, eq } from "drizzle-orm";
import type { DbOrTx } from "../tunnels/db";

export async function assertConnectionInTeam(
	db: DbOrTx,
	teamId: string,
	connectionId: string
): Promise<boolean> {
	const rows = await db
		.select({ id: dbSchema.dbConnection.id })
		.from(dbSchema.dbConnection)
		.where(
			and(
				eq(dbSchema.dbConnection.teamId, teamId),
				eq(dbSchema.dbConnection.id, connectionId)
			)
		)
		.limit(1);
	return rows.length > 0;
}
