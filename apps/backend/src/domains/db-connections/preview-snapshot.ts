/**
 * `putPreviewSnapshot` — enregistre le snapshot précalculé du dernier
 * rendu de preview d'une `db_connection`.
 *
 * Sans snapshot, la gallery affiche "CLI hors ligne" dès que l'user n'a
 * plus son CLI actif. Avec, elle re-render le dernier état connu côté
 * client (theme-aware, léger : quelques KB de JSON).
 *
 * Contrat :
 *   - Auth cookie requise (route sous `requireUser`).
 *   - `connectionId` DOIT appartenir au user (WHERE user_id — pas de
 *     404 fuit vs 403 : on renvoie `ok: false, reason: "not_found"`
 *     dans les 2 cas, `not_found` ambigu par design).
 *   - Le snapshot est stocké tel quel en `jsonb`. La validation de
 *     forme est côté Zod (route) — l'écriture DB ne re-valide pas.
 */

import { schema as dbSchema } from "@sqlnest/db";
import { and, eq } from "drizzle-orm";
import type { DbOrTx } from "../tunnels/db";

export type PutPreviewSnapshotFailureReason = "not_found";

export type PutPreviewSnapshotResult =
	| { readonly ok: true }
	| { readonly ok: false; readonly reason: PutPreviewSnapshotFailureReason };

export async function putPreviewSnapshot(
	db: DbOrTx,
	userId: string,
	connectionId: string,
	snapshot: unknown
): Promise<PutPreviewSnapshotResult> {
	const updated = await db
		.update(dbSchema.dbConnection)
		.set({ lastPreviewSnapshot: snapshot })
		.where(
			and(
				eq(dbSchema.dbConnection.userId, userId),
				eq(dbSchema.dbConnection.id, connectionId)
			)
		)
		.returning({ id: dbSchema.dbConnection.id });

	if (updated.length === 0) {
		return { ok: false, reason: "not_found" };
	}
	return { ok: true };
}
