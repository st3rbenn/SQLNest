/**
 * Tests unit — dérivation keypair backend depuis AUTH_SECRET.
 */

import { ed25519 } from "@noble/curves/ed25519.js";
import { describe, expect, test } from "vitest";
import { deriveBackendKeypair } from "./keypair";

const SECRET_A = "a".repeat(32);
const SECRET_B = "b".repeat(32);

describe("deriveBackendKeypair", () => {
	test("privkey 32 bytes + pubkey 32 bytes + hex 64 chars", () => {
		const kp = deriveBackendKeypair(SECRET_A);
		expect(kp.privateKey.length).toBe(32);
		expect(kp.publicKey.length).toBe(32);
		expect(kp.publicKeyHex).toMatch(/^[0-9a-f]{64}$/);
	});

	test("déterministe — même AUTH_SECRET → même keypair", () => {
		const k1 = deriveBackendKeypair(SECRET_A);
		const k2 = deriveBackendKeypair(SECRET_A);
		expect(k1.privateKey).toEqual(k2.privateKey);
		expect(k1.publicKey).toEqual(k2.publicKey);
		expect(k1.publicKeyHex).toBe(k2.publicKeyHex);
	});

	test("AUTH_SECRET différent → keypair différente", () => {
		const k1 = deriveBackendKeypair(SECRET_A);
		const k2 = deriveBackendKeypair(SECRET_B);
		expect(k1.publicKeyHex).not.toBe(k2.publicKeyHex);
	});

	test("privkey utilisable pour Ed25519 sign/verify", () => {
		const kp = deriveBackendKeypair(SECRET_A);
		const msg = new TextEncoder().encode("hello backend");
		const sig = ed25519.sign(msg, kp.privateKey);
		expect(ed25519.verify(sig, msg, kp.publicKey)).toBe(true);
	});

	test("AUTH_SECRET absent → throw explicite", () => {
		expect(() => deriveBackendKeypair(undefined)).toThrow(/AUTH_SECRET/);
	});

	test("AUTH_SECRET trop court → throw", () => {
		expect(() => deriveBackendKeypair("short")).toThrow(/32/);
	});
});
