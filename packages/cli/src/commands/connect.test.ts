/**
 * Tests unit — `sqlnest connect` (device flow).
 *
 * Injection totale (api client, sleep, now, browser opener, callbacks).
 * Aucun accès réseau ni filesystem réel — sauf le config.toml via
 * `SQLNEST_CONFIG_DIR` isolé par test.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type {
	ApiClient,
	AuthenticateResult,
	CreatePairingResult,
	PairingStatus,
	StatusPairingResult
} from "../api-client";
import { loadConfig } from "../config";
import { ConnectError, connect, loadOrInitConfig } from "./connect";

/** Fabrique un ApiClient contrôlé par vi.fn — permet les assertions et
 * scénarios (approve après N polls, timeout, etc.). */
function makeMockApi(): {
	api: ApiClient;
	stubs: {
		createPairing: ReturnType<typeof vi.fn>;
		getPairingStatus: ReturnType<typeof vi.fn>;
		authenticatePairing: ReturnType<typeof vi.fn>;
		authenticateWithToken: ReturnType<typeof vi.fn>;
	};
} {
	const createPairing = vi.fn();
	const getPairingStatus = vi.fn();
	const authenticatePairing = vi.fn();
	const authenticateWithToken = vi.fn();
	return {
		api: {
			createPairing,
			getPairingStatus,
			authenticatePairing,
			authenticateWithToken
		} as unknown as ApiClient,
		stubs: {
			createPairing,
			getPairingStatus,
			authenticatePairing,
			authenticateWithToken
		}
	};
}

function makeCreatePairingResult(
	overrides: Partial<CreatePairingResult> = {}
): CreatePairingResult {
	return {
		code: "ABCD-1234",
		expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
		pollUrl: "/api/tunnels/pairings/ABCD-1234/status",
		...overrides
	};
}

function makeStatusResult(
	status: PairingStatus,
	deviceName: string | null = null
): StatusPairingResult {
	return { status, deviceName };
}

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

let tempDir: string;

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "sqlnest-connect-test-"));
	process.env.SQLNEST_CONFIG_DIR = tempDir;
});

afterEach(() => {
	delete process.env.SQLNEST_CONFIG_DIR;
	if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
});

describe("loadOrInitConfig", () => {
	test("config absente → génère salt + keypair + save", () => {
		expect(loadConfig()).toBeNull();
		const { config, privateKeyHex } = loadOrInitConfig();
		expect(config.keypair.public).toMatch(/^[0-9a-f]{64}$/);
		expect(privateKeyHex).toMatch(/^[0-9a-f]{64}$/);
		// Config est bien persistée.
		expect(loadConfig()).not.toBeNull();
	});

	test("config existante → réutilise la keypair", () => {
		const first = loadOrInitConfig();
		const second = loadOrInitConfig();
		expect(second.config.keypair.public).toBe(first.config.keypair.public);
		expect(second.privateKeyHex).toBe(first.privateKeyHex);
	});
});

describe("connect — happy path", () => {
	test("polling: pending → pending → approved → auth → save config", async () => {
		const { api, stubs } = makeMockApi();
		stubs.createPairing.mockResolvedValue(makeCreatePairingResult());
		stubs.getPairingStatus
			.mockResolvedValueOnce(makeStatusResult("pending"))
			.mockResolvedValueOnce(makeStatusResult("pending"))
			.mockResolvedValueOnce(makeStatusResult("approved", "alice-mac"));
		stubs.authenticatePairing.mockResolvedValue(makeAuthResult());

		const sleep = vi.fn().mockResolvedValue(undefined);
		const openBrowserFn = vi.fn().mockResolvedValue(true);
		const onCodeDisplayed = vi.fn();
		const onStatus = vi.fn();

		const result = await connect({
			baseUrl: "http://localhost:4000",
			frontendUrl: "http://localhost:3000",
			api,
			sleep,
			openBrowserFn,
			onCodeDisplayed,
			onStatus
		});

		expect(result.tunnelId).toBe("11111111-1111-1111-1111-111111111111");
		expect(result.connectionName).toBe("alice-mac");
		expect(result.sessionToken).toMatch(/^tn_/);

		// createPairing appelé une fois avec la pubkey.
		expect(stubs.createPairing).toHaveBeenCalledTimes(1);
		const pubkeyArg = stubs.createPairing.mock.calls[0]?.[0] as string;
		expect(pubkeyArg).toMatch(/^[0-9a-f]{64}$/);

		// onCodeDisplayed émis.
		expect(onCodeDisplayed).toHaveBeenCalledTimes(1);
		expect(onCodeDisplayed.mock.calls[0]?.[0].code).toBe("ABCD-1234");
		expect(onCodeDisplayed.mock.calls[0]?.[0].connectUrl).toBe(
			"http://localhost:3000/connect"
		);

		// Browser tenté 1 fois.
		expect(openBrowserFn).toHaveBeenCalledTimes(1);

		// Poll 3 fois, sleep entre les 2 premiers seulement.
		expect(stubs.getPairingStatus).toHaveBeenCalledTimes(3);
		expect(sleep).toHaveBeenCalledTimes(2);
		expect(onStatus).toHaveBeenCalledTimes(3);

		// authenticatePairing appelé avec code canonique (sans dash) → mais
		// on envoie le format display, le backend normalise.
		expect(stubs.authenticatePairing).toHaveBeenCalledTimes(1);
		const [codeArg, sigArg] = stubs.authenticatePairing.mock.calls[0] ?? [];
		expect(codeArg).toBe("ABCD-1234");
		expect(sigArg).toMatch(/^[0-9a-f]{128}$/);

		// Config persistée avec le nouveau tunnel.
		const finalConfig = loadConfig();
		expect(finalConfig?.tunnels.length).toBe(1);
		expect(finalConfig?.tunnels[0]?.name).toBe("alice-mac");
		expect(finalConfig?.tunnels[0]?.session_token).toBe(result.sessionToken);
	});

	test("signature du code vérifie contre la pubkey stockée", async () => {
		const { api, stubs } = makeMockApi();
		stubs.createPairing.mockResolvedValue(
			makeCreatePairingResult({ code: "WXYZ-5678" })
		);
		stubs.getPairingStatus.mockResolvedValue(
			makeStatusResult("approved", "test-device")
		);
		stubs.authenticatePairing.mockResolvedValue(makeAuthResult());

		let capturedPubkey = "";
		let capturedSig = "";
		stubs.createPairing.mockImplementation((pubkey: string) => {
			capturedPubkey = pubkey;
			return Promise.resolve(makeCreatePairingResult({ code: "WXYZ-5678" }));
		});
		stubs.authenticatePairing.mockImplementation(
			(_code: string, sig: string) => {
				capturedSig = sig;
				return Promise.resolve(makeAuthResult());
			}
		);

		await connect({
			baseUrl: "http://localhost:4000",
			frontendUrl: "http://localhost:3000",
			api,
			sleep: vi.fn().mockResolvedValue(undefined),
			openBrowserFn: vi.fn().mockResolvedValue(true),
			openBrowserOnDisplay: false
		});

		// La sig doit vérifier contre la pubkey pour le code canonique.
		const sigBytes = Uint8Array.from(
			// biome-ignore lint/style/noNonNullAssertion: length is even (128)
			capturedSig
				.match(/.{2}/g)!
				.map((h) => Number.parseInt(h, 16))
		);
		const pubBytes = Uint8Array.from(
			// biome-ignore lint/style/noNonNullAssertion: length is even (64)
			capturedPubkey
				.match(/.{2}/g)!
				.map((h) => Number.parseInt(h, 16))
		);
		const msg = new TextEncoder().encode("WXYZ5678");
		expect(ed25519.verify(sigBytes, msg, pubBytes)).toBe(true);
	});

	test("`openBrowserOnDisplay: false` → browser pas ouvert", async () => {
		const { api, stubs } = makeMockApi();
		stubs.createPairing.mockResolvedValue(makeCreatePairingResult());
		stubs.getPairingStatus.mockResolvedValue(
			makeStatusResult("approved", "dev")
		);
		stubs.authenticatePairing.mockResolvedValue(makeAuthResult());

		const openBrowserFn = vi.fn().mockResolvedValue(true);
		await connect({
			baseUrl: "http://localhost:4000",
			frontendUrl: "http://localhost:3000",
			openBrowserOnDisplay: false,
			api,
			sleep: vi.fn().mockResolvedValue(undefined),
			openBrowserFn
		});
		expect(openBrowserFn).not.toHaveBeenCalled();
	});
});

describe("connect — cas d'erreur", () => {
	test("status `expired` → ConnectError kind=expired", async () => {
		const { api, stubs } = makeMockApi();
		stubs.createPairing.mockResolvedValue(makeCreatePairingResult());
		stubs.getPairingStatus.mockResolvedValue(makeStatusResult("expired"));

		await expect(
			connect({
				baseUrl: "http://localhost:4000",
				frontendUrl: "http://localhost:3000",
				api,
				sleep: vi.fn().mockResolvedValue(undefined),
				openBrowserOnDisplay: false
			})
		).rejects.toMatchObject({ kind: "expired" });
	});

	test("status `consumed` → ConnectError kind=consumed", async () => {
		const { api, stubs } = makeMockApi();
		stubs.createPairing.mockResolvedValue(makeCreatePairingResult());
		stubs.getPairingStatus.mockResolvedValue(makeStatusResult("consumed"));

		await expect(
			connect({
				baseUrl: "http://localhost:4000",
				frontendUrl: "http://localhost:3000",
				api,
				sleep: vi.fn().mockResolvedValue(undefined),
				openBrowserOnDisplay: false
			})
		).rejects.toMatchObject({ kind: "consumed" });
	});

	test("timeout: `now()` avance de 5min → ConnectError kind=timeout", async () => {
		const { api, stubs } = makeMockApi();
		stubs.createPairing.mockResolvedValue(makeCreatePairingResult());
		stubs.getPairingStatus.mockResolvedValue(makeStatusResult("pending"));

		let clock = 0;
		const now = () => clock;
		const sleep = vi.fn(async (ms: number) => {
			clock += ms;
		});

		await expect(
			connect({
				baseUrl: "http://localhost:4000",
				frontendUrl: "http://localhost:3000",
				api,
				now,
				sleep,
				openBrowserOnDisplay: false
			})
		).rejects.toMatchObject({ kind: "timeout" });

		// Le polling s'arrête après ~5min de polling.
		expect(clock).toBeGreaterThanOrEqual(5 * 60 * 1000);
	});

	test("authenticatePairing échec → propage l'erreur brute (ApiClientError)", async () => {
		const { api, stubs } = makeMockApi();
		stubs.createPairing.mockResolvedValue(makeCreatePairingResult());
		stubs.getPairingStatus.mockResolvedValue(
			makeStatusResult("approved", "dev")
		);
		stubs.authenticatePairing.mockRejectedValue(new Error("HTTP 401"));

		await expect(
			connect({
				baseUrl: "http://localhost:4000",
				frontendUrl: "http://localhost:3000",
				api,
				sleep: vi.fn().mockResolvedValue(undefined),
				openBrowserOnDisplay: false
			})
		).rejects.toThrow(/401/);
	});

	test("`ConnectError` expose kind + message", () => {
		const err = new ConnectError("timeout", "boom");
		expect(err.kind).toBe("timeout");
		expect(err.message).toBe("boom");
		expect(err.name).toBe("ConnectError");
	});
});
