/**
 * Schémas Zod des routes device-flow `/api/tunnels/pairings/*` et
 * `/api/tunnels/authenticate`. Séparé du domain pour être partagé
 * entre la couche route (validation request/response) et les tests
 * qui construisent des payloads typés.
 *
 * Convention identifiants : `PairingXxx`, `AuthenticateXxx`.
 */

import z from "zod/v4";

/** Regex Ed25519 pubkey — 32 bytes = 64 hex chars. */
const ED25519_PUBKEY_HEX = /^[0-9a-fA-F]{64}$/;

/** Regex Ed25519 signature détachée — 64 bytes = 128 hex chars. */
const ED25519_SIG_HEX = /^[0-9a-fA-F]{128}$/;

// ─── POST /api/tunnels/pairings ────────────────────────────────────────
// Body: le CLI envoie sa clé publique Ed25519. Le backend génère un code
// aléatoire, retourne code + expiration + poll URL.

export const CreatePairingBody = z.object({
	cliPubkeyEd25519: z
		.string()
		.regex(ED25519_PUBKEY_HEX, "Ed25519 pubkey doit être 64 chars hex"),
	/** Nom de la DSN locale que ce CLI veut servir cette session (C.13).
	 *  Optionnel pour compat avec les CLI legacy (pré-C.13) qui n'envoient
	 *  rien → le backend fallback à un fingerprint pubkey-only.
	 *  Un CLI récent DOIT l'envoyer quand plusieurs DSN sont configurées
	 *  localement pour éviter les collisions côté serveur. */
	cliConnectionName: z
		.string()
		.trim()
		.min(1, "Le nom de connection CLI ne peut pas être vide")
		.max(100, "Nom trop long (max 100)")
		.optional()
});
z.globalRegistry.add(CreatePairingBody, { id: "CreatePairingBody" });
export type CreatePairingBodyT = z.infer<typeof CreatePairingBody>;

export const CreatePairingResponse = z.object({
	/** Format affichage `XXXX-XXXX` — le CLI l'imprime tel quel. */
	code: z.string(),
	/** ISO 8601 — le CLI affiche un countdown local. */
	expiresAt: z.string(),
	/** URL relative de polling (ex `/api/tunnels/pairings/ABCD-1234/status`). */
	pollUrl: z.string()
});
z.globalRegistry.add(CreatePairingResponse, { id: "CreatePairingResponse" });
export type CreatePairingResponseT = z.infer<typeof CreatePairingResponse>;

// ─── GET /api/tunnels/pairings/:code/status ────────────────────────────
// Le CLI poll cette route toutes les ~2s. La route DOIT être stateless et
// peu chère (indexes sur `code` en PK).

export const PairingCodeParams = z.object({ code: z.string() });
z.globalRegistry.add(PairingCodeParams, { id: "PairingCodeParams" });
export type PairingCodeParamsT = z.infer<typeof PairingCodeParams>;

export const StatusPairingResponse = z.object({
	/** État du pairing. Ordre d'évaluation : `expired` > `consumed` > `approved` > `pending`. */
	status: z.enum(["pending", "approved", "expired", "consumed"]),
	/** Peuplé une fois approved (sinon null). Utile côté CLI pour dire
	 *  "Autorisé par le device 'Anthonin's MacBook'" avant de finaliser. */
	deviceName: z.string().nullable(),
	/** Peuplé UNIQUEMENT quand :
	 *   - la requête vient d'un user authentifié (cookie session),
	 *   - le fingerprint du CLI (hash de sa pubkey Ed25519) matche une
	 *     `db_connection` existante de ce user (pairing idempotent C.6).
	 *  L'UI /connect s'en sert pour adapter le flow : au lieu de demander
	 *  un `deviceName`, elle affiche "Reconnexion à <name>" — évite le
	 *  piège UX "l'user tape un nom qui sera ignoré". */
	existingConnection: z
		.object({
			id: z.string(),
			name: z.string()
		})
		.nullable()
});
z.globalRegistry.add(StatusPairingResponse, { id: "StatusPairingResponse" });
export type StatusPairingResponseT = z.infer<typeof StatusPairingResponse>;

// ─── POST /api/tunnels/pairings/:code/approve ──────────────────────────
// Auth cookie requise (user connecté sur /connect). Body: le nom que le
// user donne à cette connexion (`prod`, `staging`, `local`).

export const ApprovePairingBody = z.object({
	/** Nom court choisi par le user pour la nouvelle db_connection.
	 *
	 *  ─── Optionnel depuis C.7 ──────────────────────────────────────────
	 *  Si le CLI (fingerprint) est déjà connu de l'user (voir
	 *  `existingConnection` dans `StatusPairingResponse`), le champ est
	 *  facultatif — le backend autofill avec le nom existant. L'UI /connect
	 *  cache le champ dans ce cas pour éviter le piège "je tape un nom qui
	 *  sera silencieusement ignoré".
	 *  Si absent ET pas d'existant → 400 explicite. */
	deviceName: z
		.string()
		.trim()
		.min(1, "Le nom est requis")
		.max(100, "Nom trop long (max 100)")
		.optional()
});
z.globalRegistry.add(ApprovePairingBody, { id: "ApprovePairingBody" });
export type ApprovePairingBodyT = z.infer<typeof ApprovePairingBody>;

export const ApprovePairingResponse = z.object({
	ok: z.literal(true)
});
z.globalRegistry.add(ApprovePairingResponse, { id: "ApprovePairingResponse" });
export type ApprovePairingResponseT = z.infer<typeof ApprovePairingResponse>;

// ─── POST /api/tunnels/authenticate ────────────────────────────────────
// Public — le CLI présente le code + la signature Ed25519 du code par la
// privkey correspondant à `cli_pubkey_ed25519` du pairing. Backend :
// vérifie, INSERT db_connection + tunnel_session, retourne token clair
// (jamais visible ailleurs).

export const AuthenticateBody = z.object({
	code: z.string(),
	signature: z
		.string()
		.regex(ED25519_SIG_HEX, "Signature Ed25519 doit être 128 chars hex")
});
z.globalRegistry.add(AuthenticateBody, { id: "AuthenticateBody" });
export type AuthenticateBodyT = z.infer<typeof AuthenticateBody>;

export const AuthenticateResponse = z.object({
	/** Clear token (`tn_<hex>`) — one-shot, ne repasse jamais côté backend. */
	token: z.string(),
	/** ID de la session tunnel — passé dans l'URL du WSS `/tunnels/:tunnelId`. */
	tunnelId: z.string(),
	/** ID de la db_connection — le browser l'utilisera pour cibler cette DB. */
	connectionId: z.string(),
	/** ISO 8601 — le CLI peut décider de re-authenticate avant expi. */
	expiresAt: z.string()
});
z.globalRegistry.add(AuthenticateResponse, { id: "AuthenticateResponse" });
export type AuthenticateResponseT = z.infer<typeof AuthenticateResponse>;

// ─── POST /api/tunnels/authenticate-token ──────────────────────────────
// Mode CI/scripts — auth via header `Authorization: Bearer sn_...`
// (voir `domains/api-tokens`). Body : la clé pub Ed25519 du CLI + le nom
// de la db_connection à créer. La signature Ed25519 du device flow n'est
// pas requise (le Bearer suffit à prouver que le CLI est mandaté par
// le user).

export const AuthenticateTokenBody = z.object({
	cliPubkeyEd25519: z
		.string()
		.regex(ED25519_PUBKEY_HEX, "Ed25519 pubkey doit être 64 chars hex"),
	deviceName: z
		.string()
		.trim()
		.min(1, "Le nom est requis")
		.max(100, "Nom trop long (max 100)"),
	/** Nom de la DSN locale au CLI (C.13). Utilisé pour scoper le
	 *  fingerprint : SHA256(pubkey || "|" || cliConnectionName). Optionnel
	 *  pour compat CLI legacy. */
	cliConnectionName: z
		.string()
		.trim()
		.min(1, "Le nom de connection CLI ne peut pas être vide")
		.max(100, "Nom trop long (max 100)")
		.optional()
});
z.globalRegistry.add(AuthenticateTokenBody, { id: "AuthenticateTokenBody" });
export type AuthenticateTokenBodyT = z.infer<typeof AuthenticateTokenBody>;

/** Réponse identique au device flow (`AuthenticateResponse`) — mêmes
 * clés, mêmes contrats côté CLI. On réutilise le schema Zod directement
 * plutôt que de le cloner — cohérence garantie si le device flow évolue. */
export const AuthenticateTokenResponse = AuthenticateResponse;
export type AuthenticateTokenResponseT = z.infer<
	typeof AuthenticateTokenResponse
>;

// ─── Erreurs partagées ─────────────────────────────────────────────────
export const TunnelsErrorResponse = z.object({ message: z.string() });
z.globalRegistry.add(TunnelsErrorResponse, { id: "TunnelsErrorResponse" });
