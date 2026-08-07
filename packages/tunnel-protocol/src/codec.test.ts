/**
 * Tests unit — encode/decode des frames.
 */

import { pack } from "msgpackr";
import { describe, expect, test } from "vitest";
import {
	canonicalizeForSigning,
	decodeFrame,
	encodeFrame,
	FrameDecodeError
} from "./codec";
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

describe("encodeFrame / decodeFrame", () => {
	test("round-trip conservatif (header + payload + signature null)", () => {
		const f = makeFrame();
		const back = decodeFrame(encodeFrame(f));
		expect(back.header).toEqual(f.header);
		expect(back.payload).toEqual(f.payload);
		expect(back.signature).toBeNull();
	});

	test("round-trip avec session_nonce", () => {
		const f = makeFrame({
			header: {
				v: 1,
				dir: "browser",
				correlation_id: "corr-2",
				kind: "res",
				ts: 1_700_000_000_000,
				ctr: 42,
				session_nonce: "abcdef01"
			}
		});
		const back = decodeFrame(encodeFrame(f));
		expect(back.header.session_nonce).toBe("abcdef01");
	});

	test("round-trip avec signature 64 bytes", () => {
		const sig = new Uint8Array(64).fill(0xaa);
		const f = makeFrame({ signature: sig });
		const back = decodeFrame(encodeFrame(f));
		expect(back.signature).toEqual(sig);
	});

	test("decode d'un blob non-MessagePack → throw", () => {
		expect(() => decodeFrame(new Uint8Array([0xff, 0xff, 0xff]))).toThrow();
	});

	test("header sans `v` → throw", () => {
		const bytes = pack({
			h: { dir: "cli", correlation_id: "c", kind: "req", ts: 0, ctr: 0 },
			p: new Uint8Array()
		}) as Uint8Array;
		expect(() => decodeFrame(bytes)).toThrow(FrameDecodeError);
	});

	test("version protocole ≠ 1 → throw", () => {
		const bytes = pack({
			h: {
				v: 99,
				dir: "cli",
				correlation_id: "c",
				kind: "req",
				ts: 0,
				ctr: 0
			},
			p: new Uint8Array()
		}) as Uint8Array;
		expect(() => decodeFrame(bytes)).toThrow(/version/);
	});

	test("kind invalide → throw", () => {
		const bytes = pack({
			h: {
				v: 1,
				dir: "cli",
				correlation_id: "c",
				kind: "bogus",
				ts: 0,
				ctr: 0
			},
			p: new Uint8Array()
		}) as Uint8Array;
		expect(() => decodeFrame(bytes)).toThrow(/kind/);
	});

	test("dir invalide → throw", () => {
		const bytes = pack({
			h: {
				v: 1,
				dir: "moon",
				correlation_id: "c",
				kind: "req",
				ts: 0,
				ctr: 0
			},
			p: new Uint8Array()
		}) as Uint8Array;
		expect(() => decodeFrame(bytes)).toThrow(/dir/);
	});

	test("ctr négatif → throw", () => {
		const bytes = pack({
			h: {
				v: 1,
				dir: "cli",
				correlation_id: "c",
				kind: "req",
				ts: 0,
				ctr: -1
			},
			p: new Uint8Array()
		}) as Uint8Array;
		expect(() => decodeFrame(bytes)).toThrow(/ctr/);
	});

	test("signature de mauvaise longueur → throw", () => {
		const bytes = pack({
			h: {
				v: 1,
				dir: "cli",
				correlation_id: "c",
				kind: "req",
				ts: 0,
				ctr: 0
			},
			p: new Uint8Array(),
			s: new Uint8Array(63) // 63 au lieu de 64
		}) as Uint8Array;
		expect(() => decodeFrame(bytes)).toThrow(/signature/);
	});

	test("payload gros (10KB) → round-trip", () => {
		const big = new Uint8Array(10_000).map((_, i) => i % 256);
		const f = makeFrame({ payload: big });
		const back = decodeFrame(encodeFrame(f));
		expect(back.payload.length).toBe(10_000);
		expect(back.payload).toEqual(big);
	});
});

describe("canonicalizeForSigning", () => {
	test("produit exactement `msgpack(header) || payload`", () => {
		const f = makeFrame();
		const canonical = canonicalizeForSigning(f.header, f.payload);
		const expectedHeaderBytes = new Uint8Array(pack(f.header) as Uint8Array);
		expect(canonical.length).toBe(
			expectedHeaderBytes.length + f.payload.length
		);
		expect(canonical.slice(0, expectedHeaderBytes.length)).toEqual(
			expectedHeaderBytes
		);
		expect(canonical.slice(expectedHeaderBytes.length)).toEqual(f.payload);
	});

	test("headers différents → canonicals différents", () => {
		const a = canonicalizeForSigning(makeFrame().header, new Uint8Array([0]));
		const b = canonicalizeForSigning(
			{ ...makeFrame().header, correlation_id: "corr-99" },
			new Uint8Array([0])
		);
		expect(a).not.toEqual(b);
	});
});
