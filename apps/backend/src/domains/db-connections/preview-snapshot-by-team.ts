/**
 * `putPreviewSnapshotByTeam` — miroir team-scoped de
 * `putPreviewSnapshot`. WHERE team_id + id (au lieu de user_id + id)
 * pour verrouiller l'accès aux membres de la team (V1 : owner only).
 */

import { schema as dbSchema } from "@sqlnest/db";
import { and, eq } from "drizzle-orm";
import type { DbOrTx } from "../tunnels/db";
import type { PutPreviewSnapshotResult } from "./preview-snapshot";

export async function putPreviewSnapshotByTeam(
	db: DbOrTx,
	teamId: string,
	connectionId: string,
	snapshot: unknown
): Promise<PutPreviewSnapshotResult> {
	const updated = await db
		.update(dbSchema.dbConnection)
		.set({ lastPreviewSnapshot: snapshot })
		.where(
			and(
				eq(dbSchema.dbConnection.teamId, teamId),
				eq(dbSchema.dbConnection.id, connectionId)
			)
		)
		.returning({ id: dbSchema.dbConnection.id });

	if (updated.length === 0) {
		return { ok: false, reason: "not_found" };
	}
	return { ok: true };
}
