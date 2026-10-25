/**
 * Primitives crypto du CLI — Ed25519 keypair + chiffrement de la privkey.
 *
 * ─── Modèle de menace ─────────────────────────────────────────────────
 * On protège **le vol du fichier `config.toml` seul** (backup mal
 * configuré, disque hors du contrôle du user). Un attaquant qui a le
 * fichier chiffré mais pas accès à la machine ne peut pas reconstituer
 * la privkey — il faut aussi `hostname()`, `userInfo().username` ET le
 * salt.
 *
 * On ne protège PAS contre un attaquant qui a un shell sur la machine
 * avec le même username : il peut dériver la même clé et déchiffrer.
 * C'est acceptable en MVP — même surface qu'une clé SSH en clair (`~/.ssh/id_ed25519`)
 * ou qu'un cookie de session browser. En v2, migration vers
 * macOS Keychain / Linux Secret Service.
 *
 * ─── Choix crypto ─────────────────────────────────────────────────────
 *   - Ed25519 pour la keypair (`@noble/curves`, MIT, pure JS).
 *   - AES-256-GCM pour chiffrer la privkey (authentification intégrée,
 *     protège contre le tampering même sans signature séparée).
 *   - PBKDF2-SHA256 100k iterations pour la dérivation de clé
 *     (raisonnable pour un CLI qui déchiffre au démarrage — <100ms).
 *   - AAD `sqlnest-privkey-v1` : bump la string à `v2` pour invalider
 *     toutes les configs existantes si un jour on change le format.
 */

import {
	createCipheriv,
	createDecipheriv,
	pbkdf2Sync,
	randomBytes
} from "node:crypto";
import { hostname, userInfo } from "node:os";
import { ed25519 } from "@noble/curves/ed25519.js";

const AES_KEY_LEN = 32; // 256 bits
const AES_IV_LEN = 12; // GCM nonce standard
const AES_TAG_LEN = 16; // GCM auth tag
const PBKDF2_ITERATIONS = 100_000;
const SALT_LEN = 16; // 128 bits — suffisant pour PBKDF2

/** AAD constant — versioning implicite du format chiffré. Bump la
 * string pour invalider les blobs existants (migration forcée). */
const AAD = new TextEncoder().encode("sqlnest-privkey-v1");

export interface Keypair {
	/** 64 hex chars (32 bytes) — envoyée au backend au /pairings. */
	readonly publicHex: string;
	/** 64 hex chars (32 bytes) — utilisée pour signer les codes de pairing. */
	readonly privateHex: string;
}

/**
 * Génère une paire Ed25519. La privkey doit être immédiatement chiffrée
 * via `encryptPrivateKey` avant persistance dans `config.toml`.
 */
export function generateKeypair(): Keypair {
	const priv = ed25519.utils.randomSecretKey();
	const pub = ed25519.getPublicKey(priv);
	return {
		publicHex: Buffer.from(pub).toString("hex"),
		privateHex: Buffer.from(priv).toString("hex")
	};
}

/** Génère un salt (16 bytes) à persister dans `config.toml`. */
export function generateSalt(): string {
	return randomBytes(SALT_LEN).toString("hex");
}

/**
 * Chiffre la privkey Ed25519. Retourne `iv (12) || ct (32) || tag (16)`
 * en hex — total 60 bytes = 120 chars hex.
 *
 * ─── Non-déterministe ─────────────────────────────────────────────────
 * L'IV random à chaque appel garantit que 2 chiffrements du même clair
 * produisent des ciphertexts différents (prévient les attaques par
 * comparaison si la config est backuppée plusieurs fois).
 */
export function encryptPrivateKey(privateHex: string, saltHex: string): string {
	const key = deriveKey(saltHex);
	const iv = randomBytes(AES_IV_LEN);
	const cipher = createCipheriv("aes-256-gcm", key, iv);
	cipher.setAAD(AAD);
	const plaintext = Buffer.from(privateHex, "hex");
	const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
	const tag = cipher.getAuthTag();
	return Buffer.concat([iv, ciphertext, tag]).toString("hex");
}

/**
 * Déchiffre la privkey. Throws :
 *   - si `encryptedHex` trop court (format cassé),
 *   - si le tag GCM ne matche pas (tampering, mauvaise clé, mauvais AAD).
 *
 * Le caller doit catch et proposer de re-générer une keypair (via un
 * `sqlnest reset`) — le CLI ne peut plus s'authentifier dans ce cas.
 */
export function decryptPrivateKey(
	encryptedHex: string,
	saltHex: string
): string {
	const blob = Buffer.from(encryptedHex, "hex");
	if (blob.length < AES_IV_LEN + AES_TAG_LEN) {
		throw new Error("decryptPrivateKey: ciphertext trop court");
	}
	const iv = blob.subarray(0, AES_IV_LEN);
	const tag = blob.subarray(blob.length - AES_TAG_LEN);
	const ct = blob.subarray(AES_IV_LEN, blob.length - AES_TAG_LEN);
	const key = deriveKey(saltHex);
	const decipher = createDecipheriv("aes-256-gcm", key, iv);
	decipher.setAAD(AAD);
	decipher.setAuthTag(tag);
	const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
	return pt.toString("hex");
}

/**
 * Signe un message (typiquement le code canonique de pairing) avec la
 * privkey. Retourne 128 chars hex (signature détachée Ed25519).
 *
 * La signature vérifie côté backend contre la pubkey enregistrée au
 * `/pairings/:code/approve`.
 */
export function signMessage(message: string, privateHex: string): string {
	const priv = Buffer.from(privateHex, "hex");
	const sig = ed25519.sign(new TextEncoder().encode(message), priv);
	return Buffer.from(sig).toString("hex");
}

/**
 * Dérive la clé AES-256 à partir de (hostname + username + salt) via
 * PBKDF2-SHA256. Le salt vient de `config.toml` — chaque installation a
 * son propre salt.
 *
 * Note : `deriveKey` prend un `saltHex` (string) plutôt qu'un Buffer
 * pour simplifier l'appel depuis la couche config qui manipule des
 * strings TOML. La conversion se fait ici.
 */
function deriveKey(saltHex: string): Buffer {
	const password = `${hostname()}:${userInfo().username}`;
	return pbkdf2Sync(
		password,
		Buffer.from(saltHex, "hex"),
		PBKDF2_ITERATIONS,
		AES_KEY_LEN,
		"sha256"
	);
}
