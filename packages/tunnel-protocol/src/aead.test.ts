/**
 * Tests unit — AEAD ChaCha20-Poly1305 payload.
 */

import { describe, expect, test } from "vitest";
import { decryptPayload, encryptPayload } from "./aead";
import { deriveSharedKey, generateX25519Keypair } from "./ecdh";
import type { FrameHeader } from "./types";

function sharedKey(): Uint8Array {
	const alice = generateX25519Keypair();
	const bob = generateX25519Keypair();
	return deriveSharedKey(alice.privateKey, bob.publicKey, alice.publicKey);
}

function makeHeader(overrides: Partial<FrameHeader> = {}): FrameHeader {
	return {
		v: 1,
		dir: "browser",
		correlation_id: "corr-1",
		kind: "req",
		ts: 1_700_000_000_000,
		ctr: 1,
		...overrides
	};
}

describe("encryptPayload / decryptPayload — round-trip", () => {
	test("chiffre → déchiffre → même plaintext", () => {
		const key = sharedKey();
		const header = makeHeader();
		const plaintext = new TextEncoder().encode("hello world");
		const ct = encryptPayload(key, header, plaintext);
		const back = decryptPayload(key, header, ct);
		expect(new TextDecoder().decode(back)).toBe("hello world");
	});

	test("ciphertext > plaintext (tag 16 bytes ajouté)", () => {
		const key = sharedKey();
		const header = makeHeader();
		const plaintext = new Uint8Array(100).fill(1);
		const ct = encryptPayload(key, header, plaintext);
		expect(ct.length).toBe(plaintext.length + 16);
	});

	test("nonces différentes entre 2 ctr distincts → ciphertexts différents", () => {
		const key = sharedKey();
		const pt = new Uint8Array([1, 2, 3, 4]);
		const c1 = encryptPayload(key, makeHeader({ ctr: 1 }), pt);
		const c2 = encryptPayload(key, makeHeader({ ctr: 2 }), pt);
		expect(c1).not.toEqual(c2);
	});
});

describe("decryptPayload — cas d'erreur", () => {
	test("modifier `ctr` du header (nonce dérivée diffère) → decrypt throw", () => {
		const key = sharedKey();
		const header = makeHeader({ ctr: 5 });
		const pt = new Uint8Array([1, 2, 3, 4]);
		const ct = encryptPayload(key, header, pt);
		expect(() => decryptPayload(key, { ...header, ctr: 6 }, ct)).toThrow();
	});

	test("modifier `correlation_id` (AAD différent) → decrypt throw", () => {
		const key = sharedKey();
		const header = makeHeader();
		const pt = new Uint8Array([1, 2, 3, 4]);
		const ct = encryptPayload(key, header, pt);
		expect(() =>
			decryptPayload(key, { ...header, correlation_id: "hack" }, ct)
		).toThrow();
	});

	test("mauvaise clé → decrypt throw", () => {
		const k1 = sharedKey();
		const k2 = sharedKey();
		const header = makeHeader();
		const pt = new Uint8Array([1, 2, 3, 4]);
		const ct = encryptPayload(k1, header, pt);
		expect(() => decryptPayload(k2, header, ct)).toThrow();
	});

	test("ciphertext altéré (dernier byte XOR-flip) → throw", () => {
		const key = sharedKey();
		const header = makeHeader();
		const pt = new Uint8Array([1, 2, 3, 4]);
		const ct = encryptPayload(key, header, pt);
		const tampered = new Uint8Array(ct);
		// biome-ignore lint/style/noNonNullAssertion: length is > 0
		tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 0xff;
		expect(() => decryptPayload(key, header, tampered)).toThrow();
	});

	test("ciphertext trop court (< 16 bytes tag) → throw", () => {
		const key = sharedKey();
		const header = makeHeader();
		expect(() => decryptPayload(key, header, new Uint8Array(4))).toThrow(
			/trop court/i
		);
	});
});
