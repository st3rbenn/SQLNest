/**
 * `getCanvasChecksumHistory` — audit trail des checksums de schéma.
 *
 * Résout le canvas d'un `(userId, connectionId)` via le lookup standard
 * (fp/checksum/legacy), puis retourne les 100 derniers events checksum
 * ordonnés par `seen_at` desc. Le canvas est peuplé au fil des heartbeat/
 * authenticate (voir heartbeat.ts). Chaque event trace : quand, quel
 * checksum, depuis quelle db_connection source.
 *
 * Permet à l'user d'inspecter l'historique des évolutions de schéma de sa
 * DB vues par SQLNest — utile pour :
 *  - vérifier les migrations passées (drift detection)
 *  - identifier depuis quel device un changement est arrivé
 *  - export pour compliance/audit externe
 *
 * Read-only : aucune API de write ou delete (append-only pur).
 */

import { schema as dbSchema } from "@sqlnest/db";
import { desc, eq } from "drizzle-orm";
import type { DbOrTx } from "./db";
import { resolveCanvasByConnection } from "./resolve";
import type {
	CanvasConnectionIdT,
	ChecksumHistoryEntryT,
	ChecksumHistoryResponseT
} from "./schema";

/** Cap max — 100 entrées suffit pour toute UI timeline raisonnable. */
const HISTORY_LIMIT = 100;

export async function getCanvasChecksumHistory(
	db: DbOrTx,
	userId: string,
	connectionId: CanvasConnectionIdT
): Promise<ChecksumHistoryResponseT | null> {
	const { canvas } = await resolveCanvasByConnection(db, userId, connectionId);
	if (canvas === null) return null;

	const rows = await db
		.select({
			id: dbSchema.canvasChecksumEvent.id,
			dbSchemaChecksum: dbSchema.canvasChecksumEvent.dbSchemaChecksum,
			dbConnectionId: dbSchema.canvasChecksumEvent.dbConnectionId,
			seenAt: dbSchema.canvasChecksumEvent.seenAt
		})
		.from(dbSchema.canvasChecksumEvent)
		.where(eq(dbSchema.canvasChecksumEvent.canvasStateId, canvas.id))
		.orderBy(desc(dbSchema.canvasChecksumEvent.seenAt))
		.limit(HISTORY_LIMIT);

	const entries: ChecksumHistoryEntryT[] = rows.map((r) => ({
		id: r.id,
		dbSchemaChecksum: r.dbSchemaChecksum,
		dbConnectionId: r.dbConnectionId,
		seenAt: r.seenAt.toISOString()
	}));

	return { canvasId: canvas.id, entries };
}
