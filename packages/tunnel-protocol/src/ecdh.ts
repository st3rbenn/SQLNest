/**
 * ECDH X25519 + dérivation de clé symmétrique pour le hop E2E
 * browser ↔ CLI.
 *
 * ─── Design ───────────────────────────────────────────────────────────
 * Le browser et le CLI ont chacun une paire X25519 éphémère (générée à
 * l'ouverture du WS). Ils échangent leurs pubkeys dans les frames
 * handshake, puis dérivent une clé symmétrique via HKDF-SHA-256 sur le
 * secret partagé X25519.
 *
 * Cette clé est utilisée par `aead.ts` pour chiffrer les payloads
 * applicatifs — le backend voit passer du ciphertext qu'il ne peut pas
 * lire (règle sécu E2E du plan Bloc 7).
 *
 * ─── Choix crypto ─────────────────────────────────────────────────────
 *   - X25519 pour l'ECDH — même bibliothèque `@noble/curves` que
 *     Ed25519, MIT, pure JS (browser-safe).
 *   - HKDF-SHA-256 pour la dérivation (RFC 5869) — c'est le KDF
 *     standard depuis Noise/Signal.
 *   - Info string `sqlnest-tunnel-e2e-v1` = versioning implicite.
 */

import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { KEY_LEN } from "./types";

/** Info string du HKDF — versioning implicite du protocole E2E. */
const HKDF_INFO = new TextEncoder().encode("sqlnest-tunnel-e2e-v1");

/** Longueur de la clé sym dérivée (bytes) — 32 pour ChaCha20-Poly1305. */
const DERIVED_KEY_LEN = 32;

export interface X25519Keypair {
	readonly publicKey: Uint8Array;
	readonly privateKey: Uint8Array;
}

/**
 * Génère une paire X25519 éphémère. À faire à l'ouverture du WS, jamais
 * réutilisée entre sessions — la privkey est jetée à la fermeture.
 */
export function generateX25519Keypair(): X25519Keypair {
	const priv = x25519.utils.randomSecretKey();
	const pub = x25519.getPublicKey(priv);
	return { publicKey: pub, privateKey: priv };
}

/**
 * Dérive la clé sym partagée pour le hop E2E.
 *
 * ─── Salt ─────────────────────────────────────────────────────────────
 * Le salt HKDF DOIT être identique côté browser et CLI. On utilise la
 * concaténation des 2 pubkeys, triée pour être commutative (browser et
 * CLI voient les mêmes bytes indépendamment de qui appelle).
 *
 * ─── Sécurité forward secrecy ─────────────────────────────────────────
 * Les keypairs X25519 sont éphémères → la compromission d'une session
 * n'affecte pas les sessions passées ou futures.
 */
export function deriveSharedKey(
	ourPrivate: Uint8Array,
	theirPublic: Uint8Array,
	ourPublic: Uint8Array
): Uint8Array {
	if (ourPrivate.length !== KEY_LEN) {
		throw new Error(
			`deriveSharedKey: privkey doit faire ${KEY_LEN} bytes (reçu ${ourPrivate.length})`
		);
	}
	if (theirPublic.length !== KEY_LEN) {
		throw new Error(
			`deriveSharedKey: theirPublic doit faire ${KEY_LEN} bytes (reçu ${theirPublic.length})`
		);
	}
	const shared = x25519.getSharedSecret(ourPrivate, theirPublic);
	const salt = commutativeSalt(ourPublic, theirPublic);
	return hkdf(sha256, shared, salt, HKDF_INFO, DERIVED_KEY_LEN);
}

/** Concatène 2 pubkeys triées (ordre lexicographique bytes) pour
 *  produire un salt commutatif. */
function commutativeSalt(a: Uint8Array, b: Uint8Array): Uint8Array {
	const [first, second] = compareBytes(a, b) <= 0 ? [a, b] : [b, a];
	const out = new Uint8Array(first.length + second.length);
	out.set(first, 0);
	out.set(second, first.length);
	return out;
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
	const len = Math.min(a.length, b.length);
	for (let i = 0; i < len; i++) {
		// biome-ignore lint/style/noNonNullAssertion: len bounds guarantee
		const diff = a[i]! - b[i]!;
		if (diff !== 0) return diff;
	}
	return a.length - b.length;
}
