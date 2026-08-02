import z from "zod/v4";

/**
 * Signature du schéma introspecté — format `${engine}:${sortedCollectionNames}`.
 *
 * ─── Exemples valides ────────────────────────────────────────────────────
 *   postgres:orders,products,users
 *   mongodb:accounts,transactions
 *   postgres:public.users,public.orders
 *   mongodb:MyDb.Users,MyDb.Orders
 *
 * ─── Contraintes ─────────────────────────────────────────────────────────
 * - `engine` : lettres minuscules uniquement (`[a-z]+`) — aligné sur les
 *   engines connus (`postgres`, `mongodb`).
 * - `sortedCollectionNames` : safe permissive — bloque juste les caractères
 *   qui casseraient un log line ou un query Mongo. Tout le reste (espaces,
 *   unicode, majuscules, séparateurs `.` / `,` / `/`) est autorisé pour
 *   supporter des schémas réels (tables `public.users` en Postgres,
 *   collections Mongo `MyDb.Coll`).
 *   - Interdit : `\x00` (null-byte — casse Postgres text), `$` (préfixe
 *     réservé Mongo opérateurs, casse un query), CR / LF / TAB (safe pour
 *     logs single-line).
 * - Longueur bornée `[3, 200]` pour éviter les injections DoS via
 *   signatures géantes tout en laissant de la place pour un schéma avec
 *   plusieurs dizaines de tables.
 *
 * ─── Regex hoistée (biome useTopLevelRegex) ──────────────────────────────
 * Extraction top-level pour éviter la recompilation à chaque validation.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: null-byte bloqué volontairement.
const CANVAS_SIGNATURE_RE = /^[a-z]+:[^\x00$\n\r\t]{1,200}$/;

export const CanvasSignature = z
	.string()
	.min(3)
	.max(200)
	.regex(CANVAS_SIGNATURE_RE);

/**
 * Payload canvas — opaque côté backend.
 *
 * Le frontend sérialise ses 4 slices (positions, sizes, frames, hidden) en
 * un objet arbitraire. On ne valide PAS le contenu ici (z.record(z.unknown()))
 * pour préserver la flexibilité : le format peut évoluer côté frontend sans
 * migration backend. La sécurité est assurée par :
 *   1. Le typage `unknown` — le backend ne fait aucun deref/exécution.
 *   2. Le `bodyLimit: 100_000` (100 KB) au niveau route — évite un payload
 *      pathologique.
 *   3. Le stockage `jsonb` Postgres — parsing sécurisé côté DB.
 */
export const CanvasPayload = z.record(z.string(), z.unknown());

export const GetCanvasQuery = z.object({
	signature: CanvasSignature
});

export const PutCanvasBody = z.object({
	signature: CanvasSignature,
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

export type CanvasSignatureT = z.infer<typeof CanvasSignature>;
export type CanvasPayloadT = z.infer<typeof CanvasPayload>;
export type GetCanvasQueryT = z.infer<typeof GetCanvasQuery>;
export type PutCanvasBodyT = z.infer<typeof PutCanvasBody>;
export type GetCanvasResponseT = z.infer<typeof GetCanvasResponse>;
export type PutCanvasResponseT = z.infer<typeof PutCanvasResponse>;

// Nommage OpenAPI — respecte la convention des autres schémas exposés
// (cf. HealthResponse, SchemaModel).
z.globalRegistry.add(GetCanvasResponse, { id: "GetCanvasResponse" });
z.globalRegistry.add(PutCanvasBody, { id: "PutCanvasBody" });
z.globalRegistry.add(PutCanvasResponse, { id: "PutCanvasResponse" });
