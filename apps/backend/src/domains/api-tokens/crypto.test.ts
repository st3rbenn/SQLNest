/**
 * Tests unit — primitives API tokens.
 *
 * Couvre :
 *   - `generateApiToken` : prefix `sn_`, 64 hex après, tous uniques.
 *   - `hashApiToken`      : SHA-256 hex 64 chars.
 *   - `apiTokenDisplayPrefix` : 8 chars.
 *   - `parseBearerHeader` : accepte `Bearer sn_...`, rejette JWT, missing,
 *     mauvaise casse pas grave, refuse `bearer sn_` avec espaces bizarres.
 */

import { describe, expect, test } from "vitest";
import {
	API_TOKEN_DISPLAY_PREFIX_LENGTH,
	API_TOKEN_PREFIX,
	apiTokenDisplayPrefix,
	generateApiToken,
	hashApiToken,
	parseBearerHeader
} from "./crypto";

describe("generateApiToken", () => {
	test("prefix `sn_` + 64 hex chars", () => {
		const t = generateApiToken();
		expect(t.startsWith(API_TOKEN_PREFIX)).toBe(true);
		const body = t.slice(API_TOKEN_PREFIX.length);
		expect(body).toHaveLength(64);
		expect(body).toMatch(/^[0-9a-f]{64}$/);
	});

	test("100 tokens tous uniques", () => {
		const set = new Set<string>();
		for (let i = 0; i < 100; i++) set.add(generateApiToken());
		expect(set.size).toBe(100);
	});
});

describe("hashApiToken", () => {
	test("SHA-256 hex 64 chars, déterministe", () => {
		const t = generateApiToken();
		const h = hashApiToken(t);
		expect(h).toHaveLength(64);
		expect(h).toMatch(/^[0-9a-f]{64}$/);
		expect(hashApiToken(t)).toBe(h);
	});

	test("tokens différents → hashes différents", () => {
		const a = generateApiToken();
		const b = generateApiToken();
		expect(hashApiToken(a)).not.toBe(hashApiToken(b));
	});
});

describe("apiTokenDisplayPrefix", () => {
	test("retourne 8 chars", () => {
		const p = apiTokenDisplayPrefix("sn_1a2b3c4d5e6f");
		expect(p).toHaveLength(API_TOKEN_DISPLAY_PREFIX_LENGTH);
		expect(p).toBe("sn_1a2b3");
	});
});

describe("parseBearerHeader", () => {
	test("accepte `Bearer sn_...`", () => {
		expect(parseBearerHeader("Bearer sn_abc123")).toBe("sn_abc123");
	});

	test("case-insensitive sur `Bearer` (majuscules du header HTTP)", () => {
		expect(parseBearerHeader("bearer sn_abc123")).toBe("sn_abc123");
		expect(parseBearerHeader("BEARER sn_abc123")).toBe("sn_abc123");
	});

	test("undefined → null", () => {
		expect(parseBearerHeader(undefined)).toBeNull();
	});

	test("Basic auth → null", () => {
		expect(parseBearerHeader("Basic dXNlcjpwYXNz")).toBeNull();
	});

	test("Bearer JWT (sans prefix sn_) → null", () => {
		expect(parseBearerHeader("Bearer eyJhbGc.eyJzdWIu.abc")).toBeNull();
	});

	test("Bearer vide → null", () => {
		expect(parseBearerHeader("Bearer ")).toBeNull();
		expect(parseBearerHeader("Bearer")).toBeNull();
	});
});
