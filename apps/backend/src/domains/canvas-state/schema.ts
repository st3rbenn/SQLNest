import z from "zod/v4";

/**
 * Identifiant d'une `db_connection` — UUID v4 validé strict.
 *
 * Le canvas_state est rattaché à UNE `db_connection`. Un canvas par (user
 * × connection). Cf. `packages/db/src/schema.ts` (table `canvas_state`)
 * pour la clé unique DB.
 */
export const CanvasConnectionId = z.uuid();

/**
 * Payload canvas — opaque côté backend.
 *
 * Le frontend sérialise ses 5 slices (positions, sizes, frames, hidden,
 * edgeAnchors) en un objet arbitraire. On ne valide PAS le contenu ici
 * (z.record(z.unknown())) pour préserver la flexibilité : le format peut
 * évoluer côté frontend sans migration backend. La sécurité est assurée
 * par :
 *   1. Le typage `unknown` — le backend ne fait aucun deref/exécution.
 *   2. Le `bodyLimit: 100_000` (100 KB) au niveau route — évite un payload
 *      pathologique.
 *   3. Le stockage `jsonb` Postgres — parsing sécurisé côté DB.
 */
export const CanvasPayload = z.record(z.string(), z.unknown());

export const GetCanvasQuery = z.object({
	connectionId: CanvasConnectionId
});

export const PutCanvasBody = z.object({
	connectionId: CanvasConnectionId,
	payload: CanvasPayload
});

export const GetCanvasResponse = z.object({
	payload: CanvasPayload,
	// Date ISO renvoyée sous forme de string — le frontend n'a pas besoin du
	// type Date natif et une string est plus safe côté JSON (pas de parsing
	// implicite ambigu selon le sérializer).
	updatedAt: z.string()
});

export const PutCanvasResponse = z.object({
	updatedAt: z.string()
});

export type CanvasConnectionIdT = z.infer<typeof CanvasConnectionId>;
export type CanvasPayloadT = z.infer<typeof CanvasPayload>;
export type GetCanvasQueryT = z.infer<typeof GetCanvasQuery>;
export type PutCanvasBodyT = z.infer<typeof PutCanvasBody>;
export type GetCanvasResponseT = z.infer<typeof GetCanvasResponse>;
export type PutCanvasResponseT = z.infer<typeof PutCanvasResponse>;

/**
 * Endpoint GET /canvas-state/checksum-history?connectionId=... — expose
 * l'audit trail des checksums vus par le canvas résolu pour cette
 * db_connection. Read-only, user-scoped (auth cookie).
 *
 * Pagination cursor keyset : `cursor` opaque encode `(seen_at, id)` de la
 * dernière row de la page précédente ; `limit` par défaut 50, max 100.
 * Réponse : `entries` + `nextCursor` (null si dernière page). Le cursor
 * réutilise l'index `(canvas_state_id, seen_at)` — perf O(log N) constant.
 */
export const ChecksumHistoryQuery = z.object({
	connectionId: CanvasConnectionId,
	cursor: z.string().optional(),
	limit: z.coerce.number().int().min(1).max(100).default(50)
});
export const ChecksumHistoryEntry = z.object({
	id: z.string(),
	dbSchemaChecksum: z.string(),
	dbConnectionId: z.string().nullable(),
	seenAt: z.string()
});
export const ChecksumHistoryResponse = z.object({
	canvasId: z.string(),
	entries: z.array(ChecksumHistoryEntry),
	nextCursor: z.string().nullable()
});
export type ChecksumHistoryQueryT = z.infer<typeof ChecksumHistoryQuery>;
export type ChecksumHistoryEntryT = z.infer<typeof ChecksumHistoryEntry>;
export type ChecksumHistoryResponseT = z.infer<typeof ChecksumHistoryResponse>;

// Nommage OpenAPI — respecte la convention des autres schémas exposés
// (cf. HealthResponse, SchemaModel).
z.globalRegistry.add(GetCanvasResponse, { id: "GetCanvasResponse" });
z.globalRegistry.add(PutCanvasBody, { id: "PutCanvasBody" });
z.globalRegistry.add(PutCanvasResponse, { id: "PutCanvasResponse" });
z.globalRegistry.add(ChecksumHistoryResponse, {
	id: "ChecksumHistoryResponse"
});
