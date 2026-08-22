/**
 * `resolveCanvasByConnection` — helper central pour tout accès canvas_state.
 *
 * Le canvas n'est plus 1:1 avec une db_connection. Un même canvas est partagé
 * par toutes les db_connections d'un user dans une team qui pointent vers la
 * MÊME instance DB (même db_fingerprint) OU vers un dump identique
 * (checksum ∈ historique). Résout un connectionId en :
 *
 *   1. Le canvas moderne `(user, team, db_fingerprint)` si fp non-null →
 *      partage cross-device sur MÊME instance (Mac + Windows sur même docker).
 *   2. Sinon canvas via `(user, team) + current_checksum ∈ db_schema_checksums`
 *      → partage cross-docker (2 containers PG distincts, même dump).
 *   3. Sinon canvas legacy `(user, connection_id)` — rétro-compat pour les
 *      db_connection sans db_fingerprint encore backfillé.
 *
 * Retourne aussi les métadonnées de la db_connection résolue (teamId, fp,
 * checksum courant) pour que le put puisse créer un canvas moderne avec les
 * bonnes valeurs sans re-query.
 */

import { schema as dbSchema } from "@sqlnest/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { DbOrTx } from "./db";
import type { CanvasConnectionIdT } from "./schema";

export interface ResolvedCanvas {
	readonly id: string;
	readonly payload: unknown;
	readonly updatedAt: Date;
	readonly dbSchemaChecksums: readonly string[];
}

export interface ResolvedConnection {
	readonly teamId: string;
	readonly dbFingerprint: string | null;
	readonly dbSchemaChecksum: string | null;
}

export interface ResolveResult {
	/** Canvas trouvé pour cette db_connection via l'une des 3 stratégies. */
	readonly canvas: ResolvedCanvas | null;
	/** La db_connection résolue — utile pour put() qui doit créer un canvas
	 *  avec les bons team_id/fingerprint si aucun n'existe. `null` si la
	 *  connectionId n'existe pas OU n'appartient pas à l'user. */
	readonly connection: ResolvedConnection | null;
}

/**
 * Résout un `(userId, connectionId)` vers le canvas approprié + les
 * métadonnées de la db_connection sous-jacente. Ne throw jamais ;
 * `{ canvas: null, connection: null }` sur connection introuvable.
 */
export async function resolveCanvasByConnection(
	db: DbOrTx,
	userId: string,
	connectionId: CanvasConnectionIdT
): Promise<ResolveResult> {
	// 1. Charge la db_connection pour extraire team_id + fingerprint + checksum.
	//    Défensif : filtre par user_id via jointure implicite ? Non — la
	//    db_connection n'a pas user_id direct (elle est team-scoped). L'auth
	//    passe par requireTeamAccess en amont côté route. Ici on trust le
	//    userId fourni par le handler HTTP.
	const connRows = await db
		.select({
			teamId: dbSchema.dbConnection.teamId,
			dbFingerprint: dbSchema.dbConnection.dbFingerprint,
			dbSchemaChecksum: dbSchema.dbConnection.dbSchemaChecksum
		})
		.from(dbSchema.dbConnection)
		.where(eq(dbSchema.dbConnection.id, connectionId))
		.limit(1);

	const conn = connRows[0];
	if (!conn) return { canvas: null, connection: null };

	const resolvedConnection: ResolvedConnection = {
		teamId: conn.teamId,
		dbFingerprint: conn.dbFingerprint,
		dbSchemaChecksum: conn.dbSchemaChecksum
	};

	// Helper pour éviter la répétition select.
	const selectCanvas = async (
		where: ReturnType<typeof and> | ReturnType<typeof eq>
	): Promise<ResolvedCanvas | null> => {
		const rows = await db
			.select({
				id: dbSchema.canvasState.id,
				payload: dbSchema.canvasState.payload,
				updatedAt: dbSchema.canvasState.updatedAt,
				dbSchemaChecksums: dbSchema.canvasState.dbSchemaChecksums
			})
			.from(dbSchema.canvasState)
			.where(where)
			.limit(1);
		const row = rows[0];
		return row === undefined
			? null
			: {
					id: row.id,
					payload: row.payload,
					updatedAt: row.updatedAt,
					dbSchemaChecksums: row.dbSchemaChecksums
				};
	};

	// 2. Priorité 1 — canvas moderne par (user, team, fingerprint).
	if (conn.dbFingerprint !== null) {
		const canvas = await selectCanvas(
			and(
				eq(dbSchema.canvasState.userId, userId),
				eq(dbSchema.canvasState.teamId, conn.teamId),
				eq(dbSchema.canvasState.dbFingerprint, conn.dbFingerprint)
			)
		);
		if (canvas !== null) {
			return { canvas, connection: resolvedConnection };
		}
	}

	// 3. Priorité 2 — canvas dont l'historique de checksums contient le
	//    current checksum du CLI. Cas cross-docker (2 dumps identiques ont
	//    même checksum initial, fp différents).
	if (conn.dbSchemaChecksum !== null) {
		const canvas = await selectCanvas(
			and(
				eq(dbSchema.canvasState.userId, userId),
				eq(dbSchema.canvasState.teamId, conn.teamId),
				sql`${conn.dbSchemaChecksum} = ANY(${dbSchema.canvasState.dbSchemaChecksums})`
			)
		);
		if (canvas !== null) {
			return { canvas, connection: resolvedConnection };
		}
	}

	// 4. Priorité 3 — canvas legacy `(user, connection_id)` avec fp NULL.
	//    Rétro-compat pour les canvas créés AVANT que les db_connection
	//    aient un db_fingerprint backfillé. Backfill au premier put moderne.
	const legacy = await selectCanvas(
		and(
			eq(dbSchema.canvasState.userId, userId),
			eq(dbSchema.canvasState.connectionId, connectionId),
			isNull(dbSchema.canvasState.dbFingerprint)
		)
	);
	return { canvas: legacy, connection: resolvedConnection };
}
