/**
 * Tests unit — encode/decode HandshakePayload.
 */

import { describe, expect, test } from "vitest";
import {
	decodeHandshakePayload,
	encodeHandshakePayload,
	generateSessionNonce,
	HandshakeDecodeError,
	SESSION_NONCE_LEN
} from "./handshake";

describe("generateSessionNonce", () => {
	test("retourne 16 bytes", () => {
		expect(generateSessionNonce().length).toBe(SESSION_NONCE_LEN);
	});

	test("100 nonces uniques", () => {
		const set = new Set<string>();
		for (let i = 0; i < 100; i++) {
			set.add(Buffer.from(generateSessionNonce()).toString("hex"));
		}
		expect(set.size).toBe(100);
	});
});

describe("encode / decode HandshakePayload", () => {
	const dummyEd = new Uint8Array(32).fill(0x11);
	const dummyX = new Uint8Array(32).fill(0x22);
	const nonce = generateSessionNonce();

	test("round-trip avec x25519 optionnel", () => {
		const payload = {
			role: "cli" as const,
			ed25519_pubkey: dummyEd,
			x25519_pubkey: dummyX,
			session_nonce: nonce
		};
		const back = decodeHandshakePayload(encodeHandshakePayload(payload));
		expect(back.role).toBe("cli");
		expect(back.ed25519_pubkey).toEqual(dummyEd);
		expect(back.x25519_pubkey).toEqual(dummyX);
		expect(back.session_nonce).toEqual(nonce);
	});

	test("round-trip sans x25519 (backend n'en a pas besoin)", () => {
		const payload = {
			role: "backend" as const,
			ed25519_pubkey: dummyEd,
			session_nonce: nonce
		};
		const back = decodeHandshakePayload(encodeHandshakePayload(payload));
		expect(back.role).toBe("backend");
		expect(back.x25519_pubkey).toBeUndefined();
	});

	test("role invalide → throw", () => {
		// Bytes fabriqués avec un role bogus.
		const { pack } = require("msgpackr") as typeof import("msgpackr");
		const bytes = pack({
			role: "hacker",
			ed25519_pubkey: dummyEd,
			session_nonce: nonce
		}) as Uint8Array;
		expect(() => decodeHandshakePayload(bytes)).toThrow(HandshakeDecodeError);
	});

	test("ed25519_pubkey de 16 bytes → throw", () => {
		const { pack } = require("msgpackr") as typeof import("msgpackr");
		const bytes = pack({
			role: "cli",
			ed25519_pubkey: new Uint8Array(16),
			session_nonce: nonce
		}) as Uint8Array;
		expect(() => decodeHandshakePayload(bytes)).toThrow(/ed25519_pubkey/);
	});

	test("session_nonce longueur invalide → throw", () => {
		const { pack } = require("msgpackr") as typeof import("msgpackr");
		const bytes = pack({
			role: "cli",
			ed25519_pubkey: dummyEd,
			session_nonce: new Uint8Array(8)
		}) as Uint8Array;
		expect(() => decodeHandshakePayload(bytes)).toThrow(/session_nonce/);
	});
});
