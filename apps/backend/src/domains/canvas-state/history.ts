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
import { and, desc, eq, lt, or } from "drizzle-orm";
import type { DbOrTx } from "./db";
import { resolveCanvasByConnection } from "./resolve";
import type {
	CanvasConnectionIdT,
	ChecksumHistoryEntryT,
	ChecksumHistoryResponseT
} from "./schema";

interface Cursor {
	readonly seenAt: string;
	readonly id: string;
}

function encodeCursor(c: Cursor): string {
	return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

function decodeCursor(raw: string): Cursor | null {
	try {
		const decoded = Buffer.from(raw, "base64url").toString("utf8");
		const parsed = JSON.parse(decoded) as unknown;
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			typeof (parsed as { seenAt?: unknown }).seenAt === "string" &&
			typeof (parsed as { id?: unknown }).id === "string"
		) {
			return parsed as Cursor;
		}
	} catch {
		/* cursor malformé — se comporte comme sans cursor */
	}
	return null;
}

export async function getCanvasChecksumHistory(
	db: DbOrTx,
	userId: string,
	connectionId: CanvasConnectionIdT,
	options: { readonly cursor?: string; readonly limit?: number } = {}
): Promise<ChecksumHistoryResponseT | null> {
	const { canvas } = await resolveCanvasByConnection(db, userId, connectionId);
	if (canvas === null) return null;

	const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
	const cursor = options.cursor ? decodeCursor(options.cursor) : null;

	// Keyset : `(seen_at, id) < (cursor.seen_at, cursor.id)` — tie-break sur id
	// pour ordering stable quand deux events partagent le même timestamp (le
	// heartbeat CLI peut battre à la même seconde depuis 2 devices).
	const cursorFilter = cursor
		? and(
				eq(dbSchema.canvasChecksumEvent.canvasStateId, canvas.id),
				or(
					lt(dbSchema.canvasChecksumEvent.seenAt, new Date(cursor.seenAt)),
					and(
						eq(
							dbSchema.canvasChecksumEvent.seenAt,
							new Date(cursor.seenAt)
						),
						lt(dbSchema.canvasChecksumEvent.id, cursor.id)
					)
				)
			)
		: eq(dbSchema.canvasChecksumEvent.canvasStateId, canvas.id);

	// +1 pour détecter s'il reste des events après cette page (nextCursor).
	const rows = await db
		.select({
			id: dbSchema.canvasChecksumEvent.id,
			dbSchemaChecksum: dbSchema.canvasChecksumEvent.dbSchemaChecksum,
			dbConnectionId: dbSchema.canvasChecksumEvent.dbConnectionId,
			seenAt: dbSchema.canvasChecksumEvent.seenAt
		})
		.from(dbSchema.canvasChecksumEvent)
		.where(cursorFilter)
		.orderBy(
			desc(dbSchema.canvasChecksumEvent.seenAt),
			desc(dbSchema.canvasChecksumEvent.id)
		)
		.limit(limit + 1);

	const hasMore = rows.length > limit;
	const pageRows = hasMore ? rows.slice(0, limit) : rows;

	const entries: ChecksumHistoryEntryT[] = pageRows.map((r) => ({
		id: r.id,
		dbSchemaChecksum: r.dbSchemaChecksum,
		dbConnectionId: r.dbConnectionId,
		seenAt: r.seenAt.toISOString()
	}));

	const nextCursor =
		hasMore && entries.length > 0
			? encodeCursor({
					seenAt: entries[entries.length - 1]!.seenAt,
					id: entries[entries.length - 1]!.id
				})
			: null;

	return { canvasId: canvas.id, entries, nextCursor };
}

