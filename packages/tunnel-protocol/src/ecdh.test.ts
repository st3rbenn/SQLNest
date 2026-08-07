/**
 * Tests unit — ECDH X25519 + dérivation HKDF.
 */

import { describe, expect, test } from "vitest";
import { deriveSharedKey, generateX25519Keypair } from "./ecdh";

describe("generateX25519Keypair", () => {
	test("keys sont Uint8Array de 32 bytes", () => {
		const kp = generateX25519Keypair();
		expect(kp.publicKey).toBeInstanceOf(Uint8Array);
		expect(kp.publicKey.length).toBe(32);
		expect(kp.privateKey).toBeInstanceOf(Uint8Array);
		expect(kp.privateKey.length).toBe(32);
	});

	test("100 keypairs → 100 pubkeys uniques", () => {
		const set = new Set<string>();
		for (let i = 0; i < 100; i++) {
			const kp = generateX25519Keypair();
			set.add(Buffer.from(kp.publicKey).toString("hex"));
		}
		expect(set.size).toBe(100);
	});
});

describe("deriveSharedKey — commutative", () => {
	test("Alice(privA, pubB) === Bob(privB, pubA)", () => {
		const alice = generateX25519Keypair();
		const bob = generateX25519Keypair();
		const aliceKey = deriveSharedKey(
			alice.privateKey,
			bob.publicKey,
			alice.publicKey
		);
		const bobKey = deriveSharedKey(
			bob.privateKey,
			alice.publicKey,
			bob.publicKey
		);
		expect(aliceKey).toEqual(bobKey);
	});

	test("clé dérivée = 32 bytes", () => {
		const alice = generateX25519Keypair();
		const bob = generateX25519Keypair();
		const key = deriveSharedKey(
			alice.privateKey,
			bob.publicKey,
			alice.publicKey
		);
		expect(key.length).toBe(32);
	});

	test("keypairs différentes → clés dérivées différentes", () => {
		const alice = generateX25519Keypair();
		const bob = generateX25519Keypair();
		const carol = generateX25519Keypair();
		const ab = deriveSharedKey(
			alice.privateKey,
			bob.publicKey,
			alice.publicKey
		);
		const ac = deriveSharedKey(
			alice.privateKey,
			carol.publicKey,
			alice.publicKey
		);
		expect(ab).not.toEqual(ac);
	});

	test("mauvaise longueur privkey → throw", () => {
		const bob = generateX25519Keypair();
		expect(() =>
			deriveSharedKey(new Uint8Array(16), bob.publicKey, bob.publicKey)
		).toThrow(/privkey/);
	});

	test("mauvaise longueur their pubkey → throw", () => {
		const alice = generateX25519Keypair();
		expect(() =>
			deriveSharedKey(alice.privateKey, new Uint8Array(16), alice.publicKey)
		).toThrow(/theirPublic/);
	});
});
