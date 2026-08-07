/**
 * Tests unit — `sqlnest connect --token`.
 * Vérifie appel /authenticate-token avec Bearer + save config.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ApiClient, AuthenticateResult } from "../api-client";
import { loadConfig } from "../config";
import { connectWithToken } from "./connect-token";

function makeAuthResult(
	overrides: Partial<AuthenticateResult> = {}
): AuthenticateResult {
	return {
		token: `tn_${"a".repeat(64)}`,
		tunnelId: "11111111-1111-1111-1111-111111111111",
		connectionId: "22222222-2222-2222-2222-222222222222",
		expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
		...overrides
	};
}

function makeApi(authenticateWithToken: ReturnType<typeof vi.fn>): {
	api: ApiClient;
} {
	return {
		api: {
			createPairing: vi.fn(),
			getPairingStatus: vi.fn(),
			authenticatePairing: vi.fn(),
			authenticateWithToken
		} as unknown as ApiClient
	};
}

let tempDir: string;

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "sqlnest-connect-token-test-"));
	process.env.SQLNEST_CONFIG_DIR = tempDir;
});

afterEach(() => {
	delete process.env.SQLNEST_CONFIG_DIR;
	if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
});

describe("connectWithToken", () => {
	test("happy path — Bearer + pubkey + deviceName transmis, tunnel sauvé", async () => {
		const stub = vi.fn().mockResolvedValue(makeAuthResult());
		const { api } = makeApi(stub);

		const result = await connectWithToken({
			baseUrl: "http://localhost:4000",
			bearerToken: `sn_${"b".repeat(64)}`,
			deviceName: "ci-runner",
			api
		});

		expect(result.tunnelId).toBe("11111111-1111-1111-1111-111111111111");
		expect(result.connectionName).toBe("ci-runner");
		expect(result.sessionToken).toMatch(/^tn_/);

		expect(stub).toHaveBeenCalledTimes(1);
		const [bearerArg, pubkeyArg, nameArg] = stub.mock.calls[0] ?? [];
		expect(bearerArg).toBe(`sn_${"b".repeat(64)}`);
		expect(pubkeyArg).toMatch(/^[0-9a-f]{64}$/);
		expect(nameArg).toBe("ci-runner");

		// Config persistée.
		const cfg = loadConfig();
		expect(cfg?.tunnels.length).toBe(1);
		expect(cfg?.tunnels[0]?.name).toBe("ci-runner");
	});

	test("2 appels successifs → 2 entries dans config", async () => {
		const stub = vi
			.fn()
			.mockResolvedValueOnce(
				makeAuthResult({
					tunnelId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
					connectionId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
				})
			)
			.mockResolvedValueOnce(
				makeAuthResult({
					tunnelId: "cccccccc-cccc-cccc-cccc-cccccccccccc",
					connectionId: "dddddddd-dddd-dddd-dddd-dddddddddddd"
				})
			);
		const { api } = makeApi(stub);

		await connectWithToken({
			baseUrl: "http://localhost:4000",
			bearerToken: `sn_${"1".repeat(64)}`,
			deviceName: "ci-alpha",
			api
		});
		await connectWithToken({
			baseUrl: "http://localhost:4000",
			bearerToken: `sn_${"1".repeat(64)}`,
			deviceName: "ci-beta",
			api
		});

		const cfg = loadConfig();
		expect(cfg?.tunnels.length).toBe(2);
		expect(cfg?.tunnels[0]?.name).toBe("ci-alpha");
		expect(cfg?.tunnels[1]?.name).toBe("ci-beta");
		// Les 2 appels utilisent la MÊME keypair (générée au 1er init).
		const pubkeyA = stub.mock.calls[0]?.[1] as string;
		const pubkeyB = stub.mock.calls[1]?.[1] as string;
		expect(pubkeyA).toBe(pubkeyB);
	});

	test("échec /authenticate-token → propage", async () => {
		const stub = vi.fn().mockRejectedValue(new Error("HTTP 401"));
		const { api } = makeApi(stub);

		await expect(
			connectWithToken({
				baseUrl: "http://localhost:4000",
				bearerToken: `sn_${"0".repeat(64)}`,
				deviceName: "ci",
				api
			})
		).rejects.toThrow(/401/);
	});
});
