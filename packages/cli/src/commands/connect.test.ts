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
import { type TunnelEntry, loadConfig, saveConfig } from "../config";
import {
	ConnectError,
	connect,
	findResumableTunnel,
	loadOrInitConfig
} from "./connect";

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
			"http://localhost:3000/pair"
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

describe("findResumableTunnel", () => {
	const nowMs = Date.parse("2026-08-08T12:00:00Z");
	const futureIso = new Date(nowMs + 30 * 24 * 60 * 60 * 1000).toISOString();
	const pastIso = new Date(nowMs - 1000).toISOString();

	function makeEntry(overrides: Partial<TunnelEntry> = {}): TunnelEntry {
		return {
			id: "t1",
			name: "apollon",
			connection_id: "c1",
			session_token: "tn_xxx",
			expires_at: futureIso,
			...overrides
		};
	}

	test("matche par connection_name et retourne le tunnel valide", () => {
		const t = makeEntry({ connection_name: "apollon" });
		const result = findResumableTunnel([t], "apollon", nowMs);
		expect(result).toBe(t);
	});

	test("ignore les tunnels d'un autre connection_name", () => {
		const t = makeEntry({ connection_name: "delphi" });
		expect(findResumableTunnel([t], "apollon", nowMs)).toBeNull();
	});

	test("fallback legacy: tunnel sans connection_name dont name matche → OK", () => {
		const t = makeEntry({ name: "apollon", connection_name: undefined });
		expect(findResumableTunnel([t], "apollon", nowMs)).toBe(t);
	});

	test("fallback legacy: tunnel sans connection_name dont name mismatch → null", () => {
		const t = makeEntry({ name: "delphi", connection_name: undefined });
		expect(findResumableTunnel([t], "apollon", nowMs)).toBeNull();
	});

	test("strict match wins sur fallback legacy même si legacy plus récent", () => {
		const legacy = makeEntry({
			id: "legacy",
			name: "apollon",
			connection_name: undefined
		});
		const strict = makeEntry({
			id: "strict",
			name: "apollon-server-label",
			connection_name: "apollon"
		});
		// legacy est ajouté APRÈS strict (dernier index) → si on prenait
		// juste le plus récent, on prendrait legacy. Mais le strict match
		// doit gagner.
		const result = findResumableTunnel([strict, legacy], "apollon", nowMs);
		expect(result?.id).toBe("strict");
	});

	test("mode single-DSN (null) matche entry sans connection_name", () => {
		const t = makeEntry({ connection_name: undefined });
		expect(findResumableTunnel([t], null, nowMs)).toBe(t);
	});

	test("mode single-DSN (null) ignore entry avec connection_name scopé", () => {
		const t = makeEntry({ connection_name: "apollon" });
		expect(findResumableTunnel([t], null, nowMs)).toBeNull();
	});

	test("ignore les tunnels expirés", () => {
		const t = makeEntry({ connection_name: "apollon", expires_at: pastIso });
		expect(findResumableTunnel([t], "apollon", nowMs)).toBeNull();
	});

	test("ignore les tunnels qui expirent DANS la marge de sécurité (60s)", () => {
		const almostExpired = new Date(nowMs + 30_000).toISOString();
		const t = makeEntry({
			connection_name: "apollon",
			expires_at: almostExpired
		});
		expect(findResumableTunnel([t], "apollon", nowMs)).toBeNull();
	});

	test("plusieurs tunnels matchants → prend le plus récent (dernier ajouté)", () => {
		const older = makeEntry({
			id: "old",
			connection_name: "apollon",
			session_token: "tn_old"
		});
		const newer = makeEntry({
			id: "new",
			connection_name: "apollon",
			session_token: "tn_new"
		});
		const result = findResumableTunnel([older, newer], "apollon", nowMs);
		expect(result?.id).toBe("new");
	});

	test("array vide → null", () => {
		expect(findResumableTunnel([], "apollon", nowMs)).toBeNull();
	});

	test("expires_at malformé → tunnel ignoré", () => {
		const t = makeEntry({
			connection_name: "apollon",
			expires_at: "not-a-date"
		});
		expect(findResumableTunnel([t], "apollon", nowMs)).toBeNull();
	});
});

describe("connect — auto-resume", () => {
	test("tunnel valide en config → return direct avec resumed:true, aucun API call", async () => {
		// Seed la config avec un tunnel valide pour "apollon".
		loadOrInitConfig(); // écrit une config fraîche avec keypair
		const initial = loadConfig();
		if (initial === null) throw new Error("config not initialized");
		const futureIso = new Date(
			Date.now() + 30 * 24 * 60 * 60 * 1000
		).toISOString();
		saveConfig({
			...initial,
			tunnels: [
				{
					id: "resumed-tunnel-id",
					name: "apollon",
					connection_id: "connection-uuid",
					session_token: `tn_${"z".repeat(64)}`,
					expires_at: futureIso,
					connection_name: "apollon"
				}
			]
		});

		const { api, stubs } = makeMockApi();
		const result = await connect({
			baseUrl: "http://localhost:4000",
			frontendUrl: "http://localhost:3000",
			cliConnectionName: "apollon",
			api,
			sleep: vi.fn().mockResolvedValue(undefined),
			openBrowserOnDisplay: false
		});

		expect(result.resumed).toBe(true);
		expect(result.tunnelId).toBe("resumed-tunnel-id");
		expect(result.connectionName).toBe("apollon");
		// Zéro API call — pas de re-pair.
		expect(stubs.createPairing).not.toHaveBeenCalled();
		expect(stubs.getPairingStatus).not.toHaveBeenCalled();
		expect(stubs.authenticatePairing).not.toHaveBeenCalled();
	});

	test("tunnel expiré en config → device flow classique, resumed:false", async () => {
		loadOrInitConfig();
		const initial = loadConfig();
		if (initial === null) throw new Error("config not initialized");
		saveConfig({
			...initial,
			tunnels: [
				{
					id: "expired-id",
					name: "apollon",
					connection_id: "connection-uuid",
					session_token: `tn_${"a".repeat(64)}`,
					expires_at: new Date(Date.now() - 1000).toISOString(),
					connection_name: "apollon"
				}
			]
		});

		const { api, stubs } = makeMockApi();
		stubs.createPairing.mockResolvedValue(makeCreatePairingResult());
		stubs.getPairingStatus.mockResolvedValue(
			makeStatusResult("approved", "apollon")
		);
		stubs.authenticatePairing.mockResolvedValue(makeAuthResult());

		const result = await connect({
			baseUrl: "http://localhost:4000",
			frontendUrl: "http://localhost:3000",
			cliConnectionName: "apollon",
			api,
			sleep: vi.fn().mockResolvedValue(undefined),
			openBrowserOnDisplay: false
		});

		expect(result.resumed).toBe(false);
		expect(stubs.createPairing).toHaveBeenCalledTimes(1);
	});

	test("nouveau pair persist connection_name pour resume ultérieur", async () => {
		const { api, stubs } = makeMockApi();
		stubs.createPairing.mockResolvedValue(makeCreatePairingResult());
		stubs.getPairingStatus.mockResolvedValue(
			makeStatusResult("approved", "apollon")
		);
		stubs.authenticatePairing.mockResolvedValue(makeAuthResult());

		await connect({
			baseUrl: "http://localhost:4000",
			frontendUrl: "http://localhost:3000",
			cliConnectionName: "apollon",
			api,
			sleep: vi.fn().mockResolvedValue(undefined),
			openBrowserOnDisplay: false
		});

		const final = loadConfig();
		expect(final?.tunnels[0]?.connection_name).toBe("apollon");
	});
});
