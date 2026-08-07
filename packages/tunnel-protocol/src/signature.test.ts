/**
 * Tests unit — signature Ed25519 des frames.
 */

import { ed25519 } from "@noble/curves/ed25519.js";
import { describe, expect, test } from "vitest";
import { signFrame, verifyFrame } from "./signature";
import type { Frame } from "./types";

function makeFrame(overrides: Partial<Frame> = {}): Frame {
	return {
		header: {
			v: 1,
			dir: "cli",
			correlation_id: "corr-1",
			kind: "req",
			ts: 1_700_000_000_000,
			ctr: 1
		},
		payload: new Uint8Array([1, 2, 3, 4]),
		signature: null,
		...overrides
	};
}

function makeKeypair() {
	const priv = ed25519.utils.randomSecretKey();
	const pub = ed25519.getPublicKey(priv);
	return { priv, pub };
}

describe("signFrame / verifyFrame", () => {
	test("happy path : signe puis vérifie", () => {
		const { priv, pub } = makeKeypair();
		const f = makeFrame();
		const sig = signFrame(f.header, f.payload, priv);
		expect(sig.length).toBe(64);
		expect(verifyFrame({ ...f, signature: sig }, pub)).toBe(true);
	});

	test("frame sans signature → verify retourne false", () => {
		const { pub } = makeKeypair();
		expect(verifyFrame(makeFrame(), pub)).toBe(false);
	});

	test("mauvaise pubkey → false", () => {
		const alice = makeKeypair();
		const bob = makeKeypair();
		const f = makeFrame();
		const sig = signFrame(f.header, f.payload, alice.priv);
		expect(verifyFrame({ ...f, signature: sig }, bob.pub)).toBe(false);
	});

	test("header muté après sig → false", () => {
		const { priv, pub } = makeKeypair();
		const f = makeFrame();
		const sig = signFrame(f.header, f.payload, priv);
		const tampered: Frame = {
			...f,
			header: { ...f.header, correlation_id: "muté" },
			signature: sig
		};
		expect(verifyFrame(tampered, pub)).toBe(false);
	});

	test("payload muté après sig → false", () => {
		const { priv, pub } = makeKeypair();
		const f = makeFrame();
		const sig = signFrame(f.header, f.payload, priv);
		const tampered: Frame = {
			...f,
			payload: new Uint8Array([9, 9, 9, 9]),
			signature: sig
		};
		expect(verifyFrame(tampered, pub)).toBe(false);
	});

	test("signature de mauvaise longueur → verify false (pas throw)", () => {
		const { pub } = makeKeypair();
		const f = makeFrame({ signature: new Uint8Array(32).fill(0) });
		expect(verifyFrame(f, pub)).toBe(false);
	});

	test("pubkey de mauvaise longueur → verify false", () => {
		const { priv } = makeKeypair();
		const f = makeFrame();
		const sig = signFrame(f.header, f.payload, priv);
		expect(
			verifyFrame({ ...f, signature: sig }, new Uint8Array(16).fill(0))
		).toBe(false);
	});

	test("privkey de mauvaise longueur → signFrame throw", () => {
		const f = makeFrame();
		expect(() => signFrame(f.header, f.payload, new Uint8Array(16))).toThrow(
			/privateKey/
		);
	});
});
