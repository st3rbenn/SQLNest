/**
 * Types du protocole tunnel SQLNest — partagé backend / CLI / frontend.
 *
 * Une frame = { header, payload, signature? } sérialisée en MessagePack.
 *   - `header`    : métadonnées de routing + anti-replay (JSON en TS,
 *                   MessagePack sur le wire).
 *   - `payload`   : bytes applicatifs. Selon le hop, en clair (CLI ↔
 *                   backend) ou chiffrés ChaCha20-Poly1305 (browser ↔ CLI).
 *   - `signature` : 64 bytes Ed25519 détachée sur
 *                   `msgpack(header) || payload`. Le backend valide la
 *                   sig CLI. Le CLI valide la sig browser (via ECDH).
 */

/** Version du protocole. Bump si le format wire change. */
export const PROTOCOL_VERSION = 1 as const;

/** Direction de l'émetteur — permet au relay de router. Le nom du
 * champ est court volontairement (`dir`) : MessagePack encode chaque
 * clé littéralement, réduire la taille des headers = payload plus léger. */
export type FrameDir = "cli" | "browser" | "backend";

/** Types de frames applicatives. */
export type FrameKind =
	| "handshake" // 1re frame après connexion WS — annonce identité + ECDH pubkey.
	| "req" // browser → CLI : demande (introspect, runSnql, ping applicatif).
	| "res" // CLI → browser : réponse succès.
	| "err" // erreur applicative (pas d'erreur transport — celle-là ferme le WS).
	| "ping" // keepalive.
	| "pong"; // réponse keepalive.

/**
 * En-tête d'une frame. Tous les champs sont OBLIGATOIRES sauf ceux
 * marqués optionnels — la validation est stricte, une clé manquante =
 * frame invalide.
 */
export interface FrameHeader {
	readonly v: typeof PROTOCOL_VERSION;
	readonly dir: FrameDir;
	/** UUID / opaque — corrèle req ↔ res côté browser + relay. */
	readonly correlation_id: string;
	readonly kind: FrameKind;
	/** Timestamp d'émission en ms epoch. Le récepteur refuse une frame
	 *  hors d'une fenêtre `MAX_SKEW_MS`. */
	readonly ts: number;
	/** Compteur monotone par (session, peer). Le récepteur refuse tout
	 *  `ctr` ≤ dernier vu (protection replay). */
	readonly ctr: number;
	/** Nonce de session opaque, remise par le peer à l'handshake. Sert
	 *  de "salt" au signing pour lier chaque frame à une session
	 *  spécifique. Absent sur la frame handshake elle-même. */
	readonly session_nonce?: string;
}

/** Frame post-décodée — payload et signature en bytes bruts. */
export interface Frame {
	readonly header: FrameHeader;
	readonly payload: Uint8Array;
	/** 64 bytes Ed25519 détachée. `null` pour la 1re frame handshake avant
	 *  échange des pubkeys (édge case documenté dans `handshake.ts`). */
	readonly signature: Uint8Array | null;
}

/** Skew autorisé sur `header.ts` (protection replay + tolérance horloge). */
export const MAX_SKEW_MS = 30_000;

/** Longueur d'une signature Ed25519 détachée (bytes). */
export const ED25519_SIG_LEN = 64;

/** Longueur d'une pubkey Ed25519 / X25519 (bytes). */
export const KEY_LEN = 32;

/** Longueur d'une nonce ChaCha20-Poly1305 (bytes). */
export const CHACHA_NONCE_LEN = 12;

/** Longueur du tag Poly1305 (bytes). */
export const POLY1305_TAG_LEN = 16;
