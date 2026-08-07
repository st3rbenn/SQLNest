/**
 * Signature Ed25519 des frames.
 *
 * ─── Canonicalisation ─────────────────────────────────────────────────
 * Le signataire signe `msgpack(header) || payload` (voir
 * `canonicalizeForSigning` dans `codec.ts`). Le vérificateur reconstruit
 * exactement les mêmes bytes — MessagePack est déterministe pour nos
 * types (pas de map, uniquement des objets à clés en string).
 *
 * ─── Sécurité ─────────────────────────────────────────────────────────
 * - `sign` throw si la privkey est de mauvaise longueur.
 * - `verify` retourne un booléen — jamais throw sur input malformé
 *   (les erreurs de format doivent être court-circuitées AVANT
 *   d'atteindre la vérif).
 */

import { ed25519 } from "@noble/curves/ed25519.js";
import { canonicalizeForSigning } from "./codec";
import {
	ED25519_SIG_LEN,
	type Frame,
	type FrameHeader,
	KEY_LEN
} from "./types";

/**
 * Signe un header + payload avec `privateKey` (32 bytes) — retourne
 * la signature 64 bytes.
 *
 * Le caller passe ce résultat comme `frame.signature`.
 */
export function signFrame(
	header: FrameHeader,
	payload: Uint8Array,
	privateKey: Uint8Array
): Uint8Array {
	if (privateKey.length !== KEY_LEN) {
		throw new Error(
			`signFrame: privateKey doit faire ${KEY_LEN} bytes (reçu ${privateKey.length})`
		);
	}
	const message = canonicalizeForSigning(header, payload);
	return ed25519.sign(message, privateKey);
}

/**
 * Vérifie la signature d'une frame contre une pubkey donnée.
 * Retourne `false` si :
 *   - la frame n'a pas de signature (`null`),
 *   - la signature n'a pas la bonne longueur,
 *   - la pubkey n'a pas la bonne longueur,
 *   - la vérif crypto échoue.
 *
 * Ne throw JAMAIS — le caller peut compter sur un booléen simple.
 */
export function verifyFrame(frame: Frame, publicKey: Uint8Array): boolean {
	if (frame.signature == null) return false;
	if (frame.signature.length !== ED25519_SIG_LEN) return false;
	if (publicKey.length !== KEY_LEN) return false;
	try {
		const message = canonicalizeForSigning(frame.header, frame.payload);
		return ed25519.verify(frame.signature, message, publicKey);
	} catch {
		return false;
	}
}
