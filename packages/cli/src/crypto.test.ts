/**
 * Tests unit — primitives crypto CLI.
 *
 * Ces tests ne dépendent pas du filesystem ni d'une DB — purement
 * fonctionnels. Ils utilisent `hostname()` et `userInfo()` de la machine
 * hôte, mais le résultat reste déterministe intra-run (le round-trip
 * chiffre → déchiffre sur la même machine doit toujours réussir).
 */

import { describe, expect, test } from "vitest";
import {
	decryptPrivateKey,
	encryptPrivateKey,
	generateKeypair,
	generateSalt,
	signMessage
} from "./crypto";

describe("generateKeypair", () => {
	test("produit 64 hex chars public + 64 hex chars private", () => {
		const kp = generateKeypair();
		expect(kp.publicHex).toMatch(/^[0-9a-f]{64}$/);
		expect(kp.privateHex).toMatch(/^[0-9a-f]{64}$/);
	});

	test("100 keypairs — pubkeys uniques (collision improbable)", () => {
		const pubs = new Set<string>();
		for (let i = 0; i < 100; i++) pubs.add(generateKeypair().publicHex);
		expect(pubs.size).toBe(100);
	});
});

describe("generateSalt", () => {
	test("32 hex chars (16 bytes)", () => {
		expect(generateSalt()).toMatch(/^[0-9a-f]{32}$/);
	});

	test("100 salts uniques", () => {
		const set = new Set<string>();
		for (let i = 0; i < 100; i++) set.add(generateSalt());
		expect(set.size).toBe(100);
	});
});

describe("encrypt / decrypt privkey — round-trip", () => {
	test("chiffre → déchiffre → même privkey", () => {
		const salt = generateSalt();
		const kp = generateKeypair();
		const enc = encryptPrivateKey(kp.privateHex, salt);
		const dec = decryptPrivateKey(enc, salt);
		expect(dec).toBe(kp.privateHex);
	});

	test("ciphertext = 120 hex (12 iv + 32 ct + 16 tag → 60 bytes → 120 hex)", () => {
		const salt = generateSalt();
		const kp = generateKeypair();
		const enc = encryptPrivateKey(kp.privateHex, salt);
		expect(enc).toHaveLength(120);
		expect(enc).toMatch(/^[0-9a-f]{120}$/);
	});

	test("non-déterministe — 2 chiffrements du même clair diffèrent", () => {
		const salt = generateSalt();
		const kp = generateKeypair();
		const a = encryptPrivateKey(kp.privateHex, salt);
		const b = encryptPrivateKey(kp.privateHex, salt);
		expect(a).not.toBe(b);
		// Mais les 2 déchiffrent bien.
		expect(decryptPrivateKey(a, salt)).toBe(kp.privateHex);
		expect(decryptPrivateKey(b, salt)).toBe(kp.privateHex);
	});
});

describe("decryptPrivateKey — cas d'erreur", () => {
	test("mauvais salt → throw", () => {
		const kp = generateKeypair();
		const salt = generateSalt();
		const enc = encryptPrivateKey(kp.privateHex, salt);
		const wrongSalt = generateSalt();
		expect(() => decryptPrivateKey(enc, wrongSalt)).toThrow();
	});

	test("ciphertext altéré (dernier byte XOR-flippé) → throw (GCM tag)", () => {
		const salt = generateSalt();
		const kp = generateKeypair();
		const enc = encryptPrivateKey(kp.privateHex, salt);
		// XOR le dernier byte (dernier 2 hex chars) avec 0xff pour garantir
		// un flip effectif — un simple remplacement par "00" fait no-op si
		// le byte d'origine valait déjà 00.
		const lastByte = Number.parseInt(enc.slice(-2), 16) ^ 0xff;
		const tampered = `${enc.slice(0, -2)}${lastByte.toString(16).padStart(2, "0")}`;
		expect(() => decryptPrivateKey(tampered, salt)).toThrow();
	});

	test("blob trop court → throw", () => {
		expect(() => decryptPrivateKey("abcd", "ef".repeat(16))).toThrow(
			/trop court/i
		);
	});
});

describe("signMessage", () => {
	test("signature Ed25519 = 128 hex chars", () => {
		const kp = generateKeypair();
		const sig = signMessage("ABCD1234", kp.privateHex);
		expect(sig).toMatch(/^[0-9a-f]{128}$/);
	});

	test("déterministe — même clair + même privkey → même sig (Ed25519)", () => {
		const kp = generateKeypair();
		expect(signMessage("HELLO", kp.privateHex)).toBe(
			signMessage("HELLO", kp.privateHex)
		);
	});
});
