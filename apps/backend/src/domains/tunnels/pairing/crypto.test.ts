/**
 * Tests unit — primitives crypto du pairing device-flow.
 *
 * Pas de DB requise. Vérifie :
 *   - `generatePairingCode` : longueur + alphabet + entropie visible
 *     (100 codes → au moins 50 uniques).
 *   - `formatPairingCode`   : dash inséré au bon endroit.
 *   - `normalizePairingCode`: strip dash/espaces, upper-case, remap
 *     Crockford (I→1, L→1, O→0, U→V), rejette longueurs/alphabets
 *     invalides.
 *   - `verifyEd25519`       : sig valide → true, altération message
 *     ou pubkey → false, format cassé → false (pas de throw).
 *   - `hashSha256Hex`       : longueur 64, déterministe, différents
 *     inputs → différents outputs.
 *   - `generateSessionToken`: prefix `tn_`, 64 hex après le prefix,
 *     100 tokens → 100 uniques.
 */

import { ed25519 } from "@noble/curves/ed25519.js";
import { describe, expect, test } from "vitest";
import {
	computeCliFingerprint,
	formatPairingCode,
	generatePairingCode,
	generateSessionToken,
	hashSha256Hex,
	normalizePairingCode,
	PAIRING_CODE_LENGTH,
	TUNNEL_TOKEN_PREFIX,
	verifyEd25519
} from "./crypto";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

describe("generatePairingCode", () => {
	test("retourne 8 chars uniquement dans l'alphabet Crockford", () => {
		for (let i = 0; i < 200; i++) {
			const code = generatePairingCode();
			expect(code).toHaveLength(PAIRING_CODE_LENGTH);
			for (const ch of code) {
				expect(CROCKFORD).toContain(ch);
			}
		}
	});

	test("distribue les codes (100 tirages → collisions rarissimes)", () => {
		const codes = new Set<string>();
		for (let i = 0; i < 100; i++) codes.add(generatePairingCode());
		// Avec 40 bits d'entropie, avoir 100 tirages tous uniques est
		// quasi certain (birthday paradox : collision attendue vers 2^20).
		expect(codes.size).toBe(100);
	});
});

describe("formatPairingCode", () => {
	test("insère un dash au milieu (XXXX-XXXX)", () => {
		expect(formatPairingCode("ABCD1234")).toBe("ABCD-1234");
	});

	test("throw si longueur ≠ 8", () => {
		expect(() => formatPairingCode("ABC")).toThrow();
		expect(() => formatPairingCode("ABCDEFGHI")).toThrow();
	});
});

describe("normalizePairingCode", () => {
	test("accepte le format canonique 8 chars upper", () => {
		expect(normalizePairingCode("ABCD1234")).toBe("ABCD1234");
	});

	test("accepte le format avec dash", () => {
		expect(normalizePairingCode("ABCD-1234")).toBe("ABCD1234");
	});

	test("strip espaces", () => {
		expect(normalizePairingCode("  AB CD-12 34 ")).toBe("ABCD1234");
	});

	test("upper-case l'input", () => {
		expect(normalizePairingCode("abcd-1234")).toBe("ABCD1234");
	});

	test("remap Crockford confusables (I,L→1 ; O→0 ; U→V)", () => {
		// `I` et `L` → `1`. `O` → `0`. `U` → `V`.
		expect(normalizePairingCode("ILOU-1234")).toBe("110V1234");
		expect(normalizePairingCode("iLoU-1234")).toBe("110V1234");
	});

	test("rejette longueur ≠ 8", () => {
		expect(normalizePairingCode("ABC")).toBeNull();
		expect(normalizePairingCode("ABCDEFGHI")).toBeNull();
	});

	test("rejette caractères hors alphabet", () => {
		// `?` n'est ni dans l'alphabet, ni dans le remap.
		expect(normalizePairingCode("ABCD-12?4")).toBeNull();
	});
});

describe("verifyEd25519", () => {
	// Génère une paire une fois pour tous les tests de vérif.
	const priv = ed25519.utils.randomSecretKey();
	const pub = ed25519.getPublicKey(priv);
	const pubHex = Buffer.from(pub).toString("hex");
	const message = "ABCD1234";
	const sigHex = Buffer.from(
		ed25519.sign(new TextEncoder().encode(message), priv)
	).toString("hex");

	test("signature valide → true", () => {
		expect(verifyEd25519(message, sigHex, pubHex)).toBe(true);
	});

	test("message altéré → false", () => {
		expect(verifyEd25519("ABCD1235", sigHex, pubHex)).toBe(false);
	});

	test("pubkey altérée → false", () => {
		const other = ed25519.getPublicKey(ed25519.utils.randomSecretKey());
		expect(
			verifyEd25519(message, sigHex, Buffer.from(other).toString("hex"))
		).toBe(false);
	});

	test("sig longueur cassée → false (ne throw pas)", () => {
		expect(verifyEd25519(message, "abcd", pubHex)).toBe(false);
	});

	test("pubkey longueur cassée → false", () => {
		expect(verifyEd25519(message, sigHex, "abcd")).toBe(false);
	});

	test("hex invalide → false (pas de throw)", () => {
		expect(verifyEd25519(message, "z".repeat(128), pubHex)).toBe(false);
		expect(verifyEd25519(message, sigHex, "z".repeat(64))).toBe(false);
	});
});

describe("hashSha256Hex", () => {
	test("longueur 64 chars hex", () => {
		expect(hashSha256Hex("foo")).toHaveLength(64);
		expect(hashSha256Hex("foo")).toMatch(/^[0-9a-f]{64}$/);
	});

	test("déterministe", () => {
		expect(hashSha256Hex("foo")).toBe(hashSha256Hex("foo"));
	});

	test("inputs différents → outputs différents", () => {
		expect(hashSha256Hex("foo")).not.toBe(hashSha256Hex("bar"));
	});
});

describe("computeCliFingerprint", () => {
	const pubkey = "a".repeat(64); // hex Ed25519 valide

	test("compat legacy — sans connectionName → SHA256(pubkey) seul", () => {
		expect(computeCliFingerprint(pubkey, null)).toBe(hashSha256Hex(pubkey));
		expect(computeCliFingerprint(pubkey, undefined)).toBe(
			hashSha256Hex(pubkey)
		);
		expect(computeCliFingerprint(pubkey, "")).toBe(hashSha256Hex(pubkey));
	});

	test("scopé — pré-hash pubkey puis SHA256(hash || '|' || name)", () => {
		const scoped = computeCliFingerprint(pubkey, "apollon");
		expect(scoped).toHaveLength(64);
		expect(scoped).toMatch(/^[0-9a-f]{64}$/);
		expect(scoped).not.toBe(hashSha256Hex(pubkey));
		const expected = hashSha256Hex(`${hashSha256Hex(pubkey)}|apollon`);
		expect(scoped).toBe(expected);
	});

	test("noms distincts → fingerprints distincts", () => {
		expect(computeCliFingerprint(pubkey, "apollon")).not.toBe(
			computeCliFingerprint(pubkey, "delphi")
		);
	});

	test("pubkeys distinctes → fingerprints distincts (même name)", () => {
		expect(computeCliFingerprint("a".repeat(64), "apollon")).not.toBe(
			computeCliFingerprint("b".repeat(64), "apollon")
		);
	});

	test("(pubA, 'b|c') ≠ (pubA + 'b', 'c') — length-prefix implicite via pré-hash", () => {
		expect(computeCliFingerprint("aa", "b|c")).not.toBe(
			computeCliFingerprint("aa|b", "c")
		);
	});
});

describe("generateSessionToken", () => {
	test("prefix `tn_` + 64 hex chars", () => {
		const token = generateSessionToken();
		expect(token.startsWith(TUNNEL_TOKEN_PREFIX)).toBe(true);
		const body = token.slice(TUNNEL_TOKEN_PREFIX.length);
		expect(body).toHaveLength(64);
		expect(body).toMatch(/^[0-9a-f]{64}$/);
	});

	test("100 tokens tous uniques", () => {
		const tokens = new Set<string>();
		for (let i = 0; i < 100; i++) tokens.add(generateSessionToken());
		expect(tokens.size).toBe(100);
	});
});
