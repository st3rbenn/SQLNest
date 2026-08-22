/**
 * Frames de handshake — 1re frame échangée après ouverture du WS.
 *
 * ─── Rôle ─────────────────────────────────────────────────────────────
 * Chaque peer annonce :
 *   - Son identité (`role` = "cli" | "browser").
 *   - Sa pubkey Ed25519 (pour vérifier les signatures suivantes).
 *   - Sa pubkey X25519 (pour dériver la clé E2E — browser ↔ CLI).
 *   - Une `session_nonce` opaque (utilisée par le peer distant dans ses
 *     futures frames).
 *
 * Après réception, chaque peer :
 *   1. Stocke la pubkey Ed25519 pour vérifier les frames suivantes.
 *   2. Dérive la clé sym partagée via ECDH (si browser ↔ CLI).
 *   3. Utilise la `session_nonce` distante dans ses propres frames.
 *
 * ─── Signature ────────────────────────────────────────────────────────
 * La frame handshake est signée avec la PRIVKEY Ed25519 de l'émetteur.
 * Le récepteur la vérifie contre la PUBKEY qui est justement dedans —
 * c'est un self-signed handshake. La vraie protection vient d'un
 * pinning externe :
 *   - Backend ↔ CLI : la pubkey Ed25519 du CLI a été enregistrée au
 *     `/tunnels/pairings/:code/approve`. Le backend refuse
 *     tout handshake dont la pubkey ne matche pas.
 *   - Browser ↔ CLI : la pubkey X25519 du CLI est aussi signée avec
 *     la privkey Ed25519 pinnée — le browser vérifie contre la même
 *     pubkey Ed25519 du CLI (obtenue via API HTTP `/db-connections/:id`
 *     avant d'ouvrir le WS, non couvert par ce module).
 */

import { randomBytes } from "node:crypto";
import { pack, unpack } from "msgpackr";

/** Longueur d'une session nonce en bytes (16 = 128 bits). */
export const SESSION_NONCE_LEN = 16;

export type HandshakeRole = "cli" | "browser" | "backend";

/** Contenu applicatif de la frame handshake (avant sérialisation en
 *  bytes du `frame.payload`). */
export interface HandshakePayload {
	readonly role: HandshakeRole;
	/** 32 bytes hex — pour vérifier les futures signatures. */
	readonly ed25519_pubkey: Uint8Array;
	/** 32 bytes — pour l'ECDH E2E (browser ↔ CLI). Optionnel pour
	 *  le hop backend qui ne fait pas de chiffrement E2E. */
	readonly x25519_pubkey?: Uint8Array;
	/** 16 bytes opaque — le peer local mettra cette valeur dans son
	 *  `header.session_nonce` sur les frames suivantes. */
	readonly session_nonce: Uint8Array;
}

/** Génère une nonce de session aléatoire (CSPRNG Node). */
export function generateSessionNonce(): Uint8Array {
	return new Uint8Array(randomBytes(SESSION_NONCE_LEN));
}

/**
 * Sérialise un `HandshakePayload` vers les bytes qui iront dans
 * `frame.payload`. MessagePack pour cohérence avec le reste du protocole.
 */
export function encodeHandshakePayload(payload: HandshakePayload): Uint8Array {
	const raw = pack({
		role: payload.role,
		ed25519_pubkey: payload.ed25519_pubkey,
		...(payload.x25519_pubkey !== undefined
			? { x25519_pubkey: payload.x25519_pubkey }
			: {}),
		session_nonce: payload.session_nonce
	}) as Uint8Array | Buffer;
	return raw instanceof Uint8Array && !Buffer.isBuffer(raw)
		? raw
		: new Uint8Array(raw);
}

/** Désérialise et valide un `HandshakePayload`. Throw si format cassé. */
export function decodeHandshakePayload(bytes: Uint8Array): HandshakePayload {
	const raw = unpack(bytes) as unknown;
	if (raw == null || typeof raw !== "object") {
		throw new HandshakeDecodeError("payload doit être un objet");
	}
	const obj = raw as Record<string, unknown>;
	if (typeof obj.role !== "string") {
		throw new HandshakeDecodeError("`role` manquant");
	}
	if (!["cli", "browser", "backend"].includes(obj.role)) {
		throw new HandshakeDecodeError(`\`role\` invalide (${obj.role})`);
	}
	const ed = normalizeBytes(obj.ed25519_pubkey, "ed25519_pubkey");
	if (ed.length !== 32) {
		throw new HandshakeDecodeError(
			`ed25519_pubkey doit faire 32 bytes (reçu ${ed.length})`
		);
	}
	const sess = normalizeBytes(obj.session_nonce, "session_nonce");
	if (sess.length !== SESSION_NONCE_LEN) {
		throw new HandshakeDecodeError(
			`session_nonce doit faire ${SESSION_NONCE_LEN} bytes (reçu ${sess.length})`
		);
	}
	let x25519: Uint8Array | undefined;
	if (obj.x25519_pubkey !== undefined) {
		x25519 = normalizeBytes(obj.x25519_pubkey, "x25519_pubkey");
		if (x25519.length !== 32) {
			throw new HandshakeDecodeError(
				`x25519_pubkey doit faire 32 bytes (reçu ${x25519.length})`
			);
		}
	}
	return {
		role: obj.role as HandshakeRole,
		ed25519_pubkey: ed,
		...(x25519 ? { x25519_pubkey: x25519 } : {}),
		session_nonce: sess
	};
}

function normalizeBytes(raw: unknown, name: string): Uint8Array {
	if (raw instanceof Uint8Array && !Buffer.isBuffer(raw)) return raw;
	if (Buffer.isBuffer(raw)) {
		return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
	}
	throw new HandshakeDecodeError(`\`${name}\` doit être des bytes`);
}

export class HandshakeDecodeError extends Error {
	constructor(message: string) {
		super(`handshake decode: ${message}`);
		this.name = "HandshakeDecodeError";
	}
}
