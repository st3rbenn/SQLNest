/**
 * AEAD ChaCha20-Poly1305 pour le chiffrement E2E browser ↔ CLI.
 *
 * ─── Modèle ───────────────────────────────────────────────────────────
 * Le browser et le CLI ont dérivé une clé sym partagée via ECDH X25519
 * (voir `ecdh.ts`). Cette clé chiffre les payloads applicatifs :
 *   - Le browser encrypt avant `frame.payload = ciphertext`.
 *   - Le CLI decrypt à la réception.
 * Le backend voit passer des bytes opaques qu'il route sans lire.
 *
 * ─── AAD ──────────────────────────────────────────────────────────────
 * L'AAD lie chaque ciphertext à son header : altérer le
 * `correlation_id` (par exemple) invalide le tag Poly1305.
 * Concrètement l'AAD = `MessagePack(header)` (le même que celui signé
 * Ed25519 — canonicalisation homogène).
 *
 * ─── Nonce ────────────────────────────────────────────────────────────
 * ChaCha20-Poly1305 utilise une nonce de 12 bytes. On la dérive
 * DÉTERMINISTIQUEMENT depuis `header.ctr` (bytes big-endian) pour :
 *   - Ne pas allouer un espace supplémentaire (`nonce_hex` dans le
 *     header serait un waste).
 *   - Garantir l'unicité (`ctr` est monotone par session, jamais
 *     réutilisé — cf. `nonce.ts`).
 * Le formatage : 4 bytes de zéros + 8 bytes counter big-endian. Suffit
 * pour 2^64 frames par session — inatteignable en pratique.
 */

import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { pack } from "msgpackr";
import { CHACHA_NONCE_LEN, type FrameHeader, POLY1305_TAG_LEN } from "./types";

/** Nombre de bytes utilisés par le compteur dans la nonce (le reste = 0). */
const NONCE_COUNTER_BYTES = 8;

/**
 * Chiffre un payload applicatif. Retourne le ciphertext + tag concaténé
 * (format standard `@noble/ciphers` : bytes[0..N] = ct, bytes[N..N+16] = tag).
 */
export function encryptPayload(
	sharedKey: Uint8Array,
	header: FrameHeader,
	plaintext: Uint8Array
): Uint8Array {
	const nonce = nonceFromCounter(header.ctr);
	const aad = canonicalHeaderBytes(header);
	const cipher = chacha20poly1305(sharedKey, nonce, aad);
	return cipher.encrypt(plaintext);
}

/**
 * Déchiffre un payload. Throw si le tag ne matche pas — signal fort
 * d'une frame altérée ou d'une confusion de clé.
 */
export function decryptPayload(
	sharedKey: Uint8Array,
	header: FrameHeader,
	ciphertext: Uint8Array
): Uint8Array {
	if (ciphertext.length < POLY1305_TAG_LEN) {
		throw new Error("decryptPayload: ciphertext trop court");
	}
	const nonce = nonceFromCounter(header.ctr);
	const aad = canonicalHeaderBytes(header);
	const cipher = chacha20poly1305(sharedKey, nonce, aad);
	return cipher.decrypt(ciphertext);
}

/** Dérive la nonce 12 bytes déterministiquement depuis `ctr`. */
function nonceFromCounter(ctr: number): Uint8Array {
	if (!Number.isInteger(ctr) || ctr < 0) {
		throw new Error(`nonceFromCounter: ctr invalide (${ctr})`);
	}
	const nonce = new Uint8Array(CHACHA_NONCE_LEN);
	// 4 premiers bytes restent à zéro. Les 8 suivants = counter big-endian.
	// `BigInt` évite les limites 32 bits de `>>>` sur les grands ctr.
	const view = new DataView(nonce.buffer);
	view.setBigUint64(CHACHA_NONCE_LEN - NONCE_COUNTER_BYTES, BigInt(ctr), false);
	return nonce;
}

/** Sérialise le header en MessagePack — même bytes que ce que
 *  `codec.canonicalizeForSigning` calcule pour la sig Ed25519.
 *  Cohérence homogène header ↔ AAD. */
function canonicalHeaderBytes(header: FrameHeader): Uint8Array {
	const bytes = pack(header) as Uint8Array | Buffer;
	return bytes instanceof Uint8Array && !Buffer.isBuffer(bytes)
		? bytes
		: new Uint8Array(bytes);
}
