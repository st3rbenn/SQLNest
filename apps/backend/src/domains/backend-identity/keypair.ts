/**
 * Identité cryptographique du backend — utilisée pour signer les frames
 * envoyées au CLI dans le flow proxy HTTP → tunnel WS.
 *
 * ─── Dérivation ───────────────────────────────────────────────────────
 * La keypair Ed25519 backend est dérivée déterministiquement d'`AUTH_SECRET`
 * via HKDF-SHA-256 avec l'info string `sqlnest-backend-signing-v1`.
 * Avantages :
 *   - Zéro secret séparé à gérer (AUTH_SECRET est déjà requis).
 *   - Reproductibilité inter-boots : la même AUTH_SECRET donne toujours
 *     la même keypair. Le CLI peut pin la pubkey backend une fois et
 *     l'utiliser sur des reboots.
 *   - Rotation : bump le suffixe (`v2`) pour invalider tous les pins
 *     existants (déclenche une resync côté CLI).
 *
 * ─── Modèle de menace ────────────────────────────────────────────────
 * La pubkey est publique par nature (route `GET /api/backend/pubkey`).
 * La privkey vit uniquement en mémoire backend, dérivée à la volée à
 * chaque boot depuis AUTH_SECRET. Un attaquant qui a la privkey a déjà
 * AUTH_SECRET — game over déjà.
 */

import { ed25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";

const HKDF_INFO = new TextEncoder().encode("sqlnest-backend-signing-v1");
const HKDF_SALT = new TextEncoder().encode("sqlnest-backend-salt-v1");
const KEY_LEN = 32;

export interface BackendKeypair {
	readonly privateKey: Uint8Array;
	readonly publicKey: Uint8Array;
	readonly publicKeyHex: string;
}

/**
 * Dérive la keypair backend depuis AUTH_SECRET. Throw si AUTH_SECRET
 * est absent ou trop court (< 32 chars, aligné sur `env.schema`).
 */
export function deriveBackendKeypair(
	authSecret: string | undefined
): BackendKeypair {
	if (!authSecret || authSecret.length < 32) {
		throw new Error(
			"deriveBackendKeypair: AUTH_SECRET manquant ou < 32 chars — impossible de dériver la keypair backend."
		);
	}
	const seed = hkdf(
		sha256,
		new TextEncoder().encode(authSecret),
		HKDF_SALT,
		HKDF_INFO,
		KEY_LEN
	);
	const publicKey = ed25519.getPublicKey(seed);
	return {
		privateKey: seed,
		publicKey,
		publicKeyHex: bytesToHex(publicKey)
	};
}

function bytesToHex(bytes: Uint8Array): string {
	let s = "";
	for (const b of bytes) s += b.toString(16).padStart(2, "0");
	return s;
}
