/**
 * Primitives crypto du device-flow CLI ↔ compte user.
 *
 * ─── Contenu ──────────────────────────────────────────────────────────
 *   - `generatePairingCode`  : code aléatoire Crockford base32 (8 chars).
 *   - `formatPairingCode`    : affichage `XXXX-XXXX` avec dash.
 *   - `normalizePairingCode` : parse input user (dash optionnel,
 *     remap I/L→1 O→0 U→V, upper-case) → forme canonique 8 chars.
 *   - `verifyEd25519`        : vérifie une signature détachée Ed25519
 *     sur les bytes UTF-8 du code canonique.
 *   - `hashSha256Hex`        : SHA-256 hex (utilisé pour hasher les
 *     tokens opaques avant persist).
 *   - `generateSessionToken` : `tn_<32 random bytes en hex>`.
 *
 * ─── Choix alphabet — Crockford sans I, L, O, U ────────────────────────
 * 32 chars = `0123456789ABCDEFGHJKMNPQRSTVWXYZ`. Retire les confusables
 * les plus fréquents à la lecture/tape :
 *   `I` → confondu avec `1`, `l`
 *   `L` → confondu avec `1`, `I`
 *   `O` → confondu avec `0`, `Q`
 *   `U` → confondu avec `V` sur certaines police / accents
 * Le user peut TAPER une de ces confusables — `normalizePairingCode` les
 * remap automatiquement, respectant la convention Crockford officielle.
 *
 * ─── Entropie ──────────────────────────────────────────────────────────
 * 8 chars × 5 bits = 40 bits = ~1.1e12 possibilités. Avec le TTL 5 min
 * et le rate-limit 10 tentatives/min/IP sur `/authenticate`, un brute-
 * force nécessiterait ~1e11 min = ~200 000 ans par IP. Rate-limit +
 * TTL sont les vraies protections ; l'entropie est de la marge.
 */

import { createHash, randomBytes } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";

// Alphabet Crockford base32 canonique (32 chars, sans I L O U). Ordre
// fixé — position `i` donne le glyphe pour la valeur `i`.
const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

// Remap des confusables tapées par l'utilisateur vers le glyphe canonique.
// Suit la convention Crockford officielle
// (https://www.crockford.com/base32.html).
const CROCKFORD_REMAP: Record<string, string> = {
	I: "1",
	L: "1",
	O: "0",
	U: "V"
};

/** Longueur canonique du code (sans dash). Change ⇒ migration cassée. */
export const PAIRING_CODE_LENGTH = 8;

/** Prefix des tokens de session tunnel — distinct des API tokens `sn_`. */
export const TUNNEL_TOKEN_PREFIX = "tn_";

/**
 * Génère un code de pairing aléatoire (`randomBytes` — CSPRNG Node).
 * Retourne la forme CANONIQUE 8 chars sans dash. Pour l'affichage
 * utilisateur, passer par {@link formatPairingCode}.
 *
 * Note : on tire un byte par char et on modulo 32 — pas de biais parce
 * que 256 % 32 = 0 (distribution uniforme sur l'alphabet).
 */
export function generatePairingCode(): string {
	const bytes = randomBytes(PAIRING_CODE_LENGTH);
	let out = "";
	for (let i = 0; i < PAIRING_CODE_LENGTH; i++) {
		// biome-ignore lint/style/noNonNullAssertion: bytes.length === PAIRING_CODE_LENGTH
		const idx = bytes[i]! % CROCKFORD_ALPHABET.length;
		out += CROCKFORD_ALPHABET[idx];
	}
	return out;
}

/** `ABCD-1234` — insère un dash au milieu pour l'affichage. */
export function formatPairingCode(canonical: string): string {
	if (canonical.length !== PAIRING_CODE_LENGTH) {
		throw new Error(
			`formatPairingCode: canonique doit faire ${PAIRING_CODE_LENGTH} chars (reçu ${canonical.length})`
		);
	}
	const half = PAIRING_CODE_LENGTH / 2;
	return `${canonical.slice(0, half)}-${canonical.slice(half)}`;
}

/**
 * Normalise un input user en code canonique. Étapes :
 *   1. Strip espaces + dashes.
 *   2. Upper-case.
 *   3. Remap Crockford confusables.
 *   4. Valide longueur + alphabet.
 *
 * Retourne `null` si l'input ne peut pas être normalisé — le caller
 * doit alors renvoyer une erreur 400 côté route.
 */
export function normalizePairingCode(input: string): string | null {
	const stripped = input.replace(/[\s-]/g, "").toUpperCase();
	if (stripped.length !== PAIRING_CODE_LENGTH) return null;
	let out = "";
	for (const ch of stripped) {
		const mapped = CROCKFORD_REMAP[ch] ?? ch;
		if (!CROCKFORD_ALPHABET.includes(mapped)) return null;
		out += mapped;
	}
	return out;
}

/**
 * Vérifie une signature détachée Ed25519 sur les bytes UTF-8 du message.
 *
 * ─── Format des inputs ────────────────────────────────────────────────
 *   - `message`      : chaîne (typiquement le code canonique 8 chars).
 *   - `signatureHex` : 128 chars hex (64 bytes) — output de `ed25519.sign`.
 *   - `pubkeyHex`    : 64 chars hex (32 bytes) — output de `ed25519.getPublicKey`.
 *
 * ─── Sécurité ─────────────────────────────────────────────────────────
 * Utilise `@noble/curves` — implémentation pure JS auditée, MIT, pas de
 * binding natif. La fonction `ed25519.verify` est constant-time et lève
 * en interne si le format est invalide — on catch pour renvoyer un
 * booléen simple (pas de fuite d'info par distinguer format-invalide de
 * sig-invalide).
 */
export function verifyEd25519(
	message: string,
	signatureHex: string,
	pubkeyHex: string
): boolean {
	try {
		const sig = hexToBytes(signatureHex);
		const pub = hexToBytes(pubkeyHex);
		if (sig.length !== 64 || pub.length !== 32) return false;
		const msgBytes = new TextEncoder().encode(message);
		return ed25519.verify(sig, msgBytes, pub);
	} catch {
		return false;
	}
}

/** SHA-256 hex (64 chars). Utilisé pour hasher tokens et pubkeys avant persist. */
export function hashSha256Hex(input: string): string {
	return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * Fingerprint effectif d'un pairing CLI.
 *
 * Un install CLI a une seule keypair Ed25519 globale, mais peut manager
 * plusieurs DSN locales via `add-connection`. Sans scoping, le lookup
 * `(user, fingerprint = SHA256(pubkey))` collapse toutes ces DSN sur une
 * seule db_connection côté serveur.
 *
 * Solution : le fingerprint inclut le NOM de la DSN CLI que ce pairing
 * sert. Deux `add-connection` (apollon / delphi) sur le même CLI produiront
 * 2 fingerprints distincts → 2 db_connection distinctes côté serveur.
 *
 * Compat : un CLI legacy qui n'envoie pas de `cliConnectionName` →
 * fingerprint = SHA256(pubkey) seul. Ses db_connection existantes restent
 * identifiables tel quel (aucune migration destructive).
 *
 * Anti-collision par length-prefix implicite :
 * On pré-hash la pubkey (SHA-256 → 64 chars hex, longueur FIXE) avant de
 * concaténer le nom. Cette longueur fixe agit comme un séparateur strict :
 * `(pubA, "b|c")` et `(pubA + "b", "c")` produiraient le même string si on
 * concaténait naïvement `pubkey + "|" + name`, mais donneront des hashs
 * distincts ici car les 2 pubkeys pré-hashées diffèrent en tête.
 */
export function computeCliFingerprint(
	cliPubkey: string,
	cliConnectionName: string | null | undefined
): string {
	if (cliConnectionName == null || cliConnectionName === "") {
		return hashSha256Hex(cliPubkey);
	}
	const pubkeyHash = hashSha256Hex(cliPubkey);
	return hashSha256Hex(`${pubkeyHash}|${cliConnectionName}`);
}

/**
 * Génère un token opaque de session tunnel : `tn_<64 hex>`. Le clair
 * n'est renvoyé qu'une fois (au CLI, en réponse de /authenticate) et
 * ne repasse jamais par le backend — le storage garde uniquement
 * `hashSha256Hex(clear)`.
 */
export function generateSessionToken(): string {
	return `${TUNNEL_TOKEN_PREFIX}${randomBytes(32).toString("hex")}`;
}

// Regex hoistée — utilisée par `hexToBytes` (règle Biome).
const HEX_RE = /^[0-9a-fA-F]*$/;

/** Parse un hex string vers `Uint8Array`. Lève si longueur impaire ou
 * caractère non-hex — le caller doit catch (voir `verifyEd25519`). */
function hexToBytes(hex: string): Uint8Array {
	if (hex.length % 2 !== 0) throw new Error("hex length must be even");
	if (!HEX_RE.test(hex)) throw new Error("hex contains non-hex chars");
	const bytes = new Uint8Array(hex.length / 2);
	for (let i = 0; i < bytes.length; i++) {
		bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	}
	return bytes;
}
