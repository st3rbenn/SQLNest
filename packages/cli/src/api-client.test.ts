/**
 * Tests unit — client HTTP API du CLI.
 *
 * Mock `fetch` via injection dans `createApiClient({ fetch: ... })`.
 * Vérifie que :
 *   - URLs construites correctement.
 *   - Bodies JSON conformes au contrat backend.
 *   - Headers Bearer bien passés pour /authenticate-token.
 *   - Response 2xx → parsed.
 *   - Response 4xx/5xx → throw `ApiClientError` avec status + body.
 */

import { describe, expect, test } from "vitest";
import { ApiClientError, createApiClient } from "./api-client";

/** Petit builder pour un mock fetch qui répond avec un payload JSON. */
function mockFetchOk(payload: unknown): {
	fetch: typeof globalThis.fetch;
	calls: Array<{ url: string; init?: RequestInit }>;
} {
	const calls: Array<{ url: string; init?: RequestInit }> = [];
	const fetch: typeof globalThis.fetch = async (input, init) => {
		calls.push({ url: String(input), init });
		return new Response(JSON.stringify(payload), {
			status: 200,
			headers: { "content-type": "application/json" }
		});
	};
	return { fetch, calls };
}

function mockFetchStatus(
	status: number,
	body: unknown
): typeof globalThis.fetch {
	return async () =>
		new Response(JSON.stringify(body), {
			status,
			headers: { "content-type": "application/json" }
		});
}

describe("createApiClient — createPairing", () => {
	test("POST /api/tunnels/pairings avec pubkey hex, retourne code+expiresAt+pollUrl", async () => {
		const payload = {
			code: "ABCD-1234",
			expiresAt: "2026-08-06T12:05:00.000Z",
			pollUrl: "/api/tunnels/pairings/ABCD-1234/status"
		};
		const { fetch, calls } = mockFetchOk(payload);
		const api = createApiClient("http://localhost:4000", { fetch });
		const pubkey = "a".repeat(64);

		const res = await api.createPairing(pubkey);

		expect(res).toEqual(payload);
		expect(calls.length).toBe(1);
		// biome-ignore lint/style/noNonNullAssertion: length checked
		expect(calls[0]!.url).toBe("http://localhost:4000/api/tunnels/pairings");
		// biome-ignore lint/style/noNonNullAssertion: length checked
		expect(calls[0]!.init?.method).toBe("POST");
		// biome-ignore lint/style/noNonNullAssertion: length checked
		const body = JSON.parse(String(calls[0]!.init?.body));
		expect(body).toEqual({ cliPubkeyEd25519: pubkey });
	});

	test("trailing slash sur baseUrl → normalisé", async () => {
		const { fetch, calls } = mockFetchOk({
			code: "X",
			expiresAt: "",
			pollUrl: ""
		});
		const api = createApiClient("http://localhost:4000//", { fetch });
		await api.createPairing("a".repeat(64));
		// biome-ignore lint/style/noNonNullAssertion: length checked
		expect(calls[0]!.url).toBe("http://localhost:4000/api/tunnels/pairings");
	});

	test("HTTP 500 → throw ApiClientError avec status + body", async () => {
		const api = createApiClient("http://localhost:4000", {
			fetch: mockFetchStatus(500, { message: "boom" })
		});
		await expect(api.createPairing("a".repeat(64))).rejects.toThrow(
			ApiClientError
		);
		try {
			await api.createPairing("a".repeat(64));
			throw new Error("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(ApiClientError);
			expect((err as ApiClientError).statusCode).toBe(500);
		}
	});
});

describe("createApiClient — getPairingStatus", () => {
	test("GET /pairings/:code/status — URL encode le code (dash conservé)", async () => {
		const { fetch, calls } = mockFetchOk({
			status: "pending",
			deviceName: null
		});
		const api = createApiClient("http://localhost:4000", { fetch });
		await api.getPairingStatus("ABCD-1234");
		// biome-ignore lint/style/noNonNullAssertion: length checked
		expect(calls[0]!.url).toBe(
			"http://localhost:4000/api/tunnels/pairings/ABCD-1234/status"
		);
		// biome-ignore lint/style/noNonNullAssertion: length checked
		expect(calls[0]!.init?.method).toBe("GET");
	});

	test("retourne la réponse typée", async () => {
		const { fetch } = mockFetchOk({
			status: "approved",
			deviceName: "alice-mac"
		});
		const api = createApiClient("http://localhost:4000", { fetch });
		const res = await api.getPairingStatus("ABCD-1234");
		expect(res.status).toBe("approved");
		expect(res.deviceName).toBe("alice-mac");
	});

	test("HTTP 400 code invalide → throw", async () => {
		const api = createApiClient("http://localhost:4000", {
			fetch: mockFetchStatus(400, { message: "Code invalide" })
		});
		await expect(api.getPairingStatus("bad")).rejects.toThrow(ApiClientError);
	});
});

describe("createApiClient — authenticatePairing (device flow)", () => {
	test("POST /authenticate avec code + signature", async () => {
		const payload = {
			token: `tn_${"a".repeat(64)}`,
			tunnelId: "11111111-1111-1111-1111-111111111111",
			connectionId: "22222222-2222-2222-2222-222222222222",
			expiresAt: "2026-09-06T12:00:00.000Z"
		};
		const { fetch, calls } = mockFetchOk(payload);
		const api = createApiClient("http://localhost:4000", { fetch });
		const sig = "b".repeat(128);

		const res = await api.authenticatePairing("ABCD-1234", sig);

		expect(res).toEqual(payload);
		// biome-ignore lint/style/noNonNullAssertion: length checked
		expect(calls[0]!.url).toBe(
			"http://localhost:4000/api/tunnels/authenticate"
		);
		// biome-ignore lint/style/noNonNullAssertion: length checked
		const body = JSON.parse(String(calls[0]!.init?.body));
		expect(body).toEqual({ code: "ABCD-1234", signature: sig });
	});

	test("HTTP 401 signature invalide → ApiClientError avec statusCode 401", async () => {
		const api = createApiClient("http://localhost:4000", {
			fetch: mockFetchStatus(401, { message: "Authentification refusée" })
		});
		try {
			await api.authenticatePairing("ABCD-1234", "0".repeat(128));
			throw new Error("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(ApiClientError);
			expect((err as ApiClientError).statusCode).toBe(401);
		}
	});
});

describe("createApiClient — authenticateWithToken (CI Bearer)", () => {
	test("POST /authenticate-token avec header Bearer + body pubkey+name", async () => {
		const payload = {
			token: `tn_${"c".repeat(64)}`,
			tunnelId: "33333333-3333-3333-3333-333333333333",
			connectionId: "44444444-4444-4444-4444-444444444444",
			expiresAt: "2026-09-06T12:00:00.000Z"
		};
		const { fetch, calls } = mockFetchOk(payload);
		const api = createApiClient("http://localhost:4000", { fetch });
		const bearer = `sn_${"d".repeat(64)}`;
		const pubkey = "e".repeat(64);

		const res = await api.authenticateWithToken(bearer, pubkey, "ci-runner");

		expect(res).toEqual(payload);
		// biome-ignore lint/style/noNonNullAssertion: length checked
		expect(calls[0]!.url).toBe(
			"http://localhost:4000/api/tunnels/authenticate-token"
		);
		// biome-ignore lint/style/noNonNullAssertion: length checked
		const headers = calls[0]!.init?.headers as Record<string, string>;
		expect(headers.authorization).toBe(`Bearer ${bearer}`);
		// biome-ignore lint/style/noNonNullAssertion: length checked
		const body = JSON.parse(String(calls[0]!.init?.body));
		expect(body).toEqual({
			cliPubkeyEd25519: pubkey,
			deviceName: "ci-runner"
		});
	});

	test("HTTP 401 token révoqué → ApiClientError statusCode 401", async () => {
		const api = createApiClient("http://localhost:4000", {
			fetch: mockFetchStatus(401, { message: "Authentification refusée" })
		});
		try {
			await api.authenticateWithToken(
				`sn_${"0".repeat(64)}`,
				"a".repeat(64),
				"ci"
			);
			throw new Error("should have thrown");
		} catch (err) {
			expect((err as ApiClientError).statusCode).toBe(401);
		}
	});
});
