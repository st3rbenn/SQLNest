/**
 * Primitives crypto des API tokens (mode CI/scripts).
 *
 * Un token clair a le format `sn_<64 hex chars>` — total 67 chars.
 * Le préfixe `sn_` (SqlNest) distingue :
 *   - des tokens de session tunnel (`tn_`, voir `tunnels/pairing/crypto.ts`),
 *   - d'un password ou d'un cookie de session Better Auth.
 *
 * Le clair n'est JAMAIS persisté. La DB stocke :
 *   - `hash`   = SHA-256(clair) — validation d'un Bearer entrant = 1 lookup.
 *   - `prefix` = les 8 premiers chars du clair (`sn_1a2b`) — pour
 *     l'affichage dashboard uniquement, pas un secret.
 *
 * Entropie : 32 bytes random = 256 bits. Un brute-force est impossible
 * même sans rate-limit — les rate-limits par IP sur
 * `/tunnels/authenticate-token` sont une couche defense-in-depth
 * (protection contre le déni de service DB, pas contre la découverte
 * du token).
 */

import { randomBytes } from "node:crypto";
import { hashSha256Hex } from "../tunnels/pairing/crypto";

/** Prefix des API tokens — distinct des tokens de session tunnel. */
export const API_TOKEN_PREFIX = "sn_";

/** Longueur du prefix affichable dans le dashboard (`sn_1a2b`). Les 5
 * chars du clair après le préfixe suffisent pour distinguer visuellement
 * plusieurs tokens sans révéler d'entropie exploitable (32 bits sur
 * 256 = ~7% — insuffisant pour rendre le clair reconstructible). */
export const API_TOKEN_DISPLAY_PREFIX_LENGTH = 8;

/**
 * Génère un token clair `sn_<64 hex>`. Le clair doit être renvoyé au CLI
 * une seule fois — ne JAMAIS le logger ni le renvoyer sur un GET.
 */
export function generateApiToken(): string {
	return `${API_TOKEN_PREFIX}${randomBytes(32).toString("hex")}`;
}

/** Le hash utilisé au storage / lookup — SHA-256 hex. */
export function hashApiToken(clear: string): string {
	return hashSha256Hex(clear);
}

/** Extrait les `API_TOKEN_DISPLAY_PREFIX_LENGTH` premiers chars du clair
 * pour affichage. Utilisé au CREATE (INSERT DB) — jamais recalculé après. */
export function apiTokenDisplayPrefix(clear: string): string {
	return clear.slice(0, API_TOKEN_DISPLAY_PREFIX_LENGTH);
}

/**
 * Parse un header `Authorization`. Retourne le clair si le header matche
 * `Bearer sn_...`, sinon `null`. On accepte uniquement des tokens
 * commençant par notre prefix pour ne pas confondre avec un JWT Bearer
 * ou une autre convention (les autres routes du monorepo utilisent le
 * cookie de session, jamais Bearer).
 */
export function parseBearerHeader(header: string | undefined): string | null {
	if (typeof header !== "string") return null;
	if (!header.toLowerCase().startsWith("bearer ")) return null;
	const token = header.slice("bearer ".length).trim();
	if (!token.startsWith(API_TOKEN_PREFIX)) return null;
	return token;
}
