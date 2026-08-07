/**
 * Tests unit — `sqlnest logout`.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	CONFIG_VERSION,
	loadConfig,
	type SqlnestConfig,
	saveConfig,
	type TunnelEntry
} from "../config";
import { encryptPrivateKey, generateKeypair, generateSalt } from "../crypto";
import { logout } from "./logout";

function seedConfig(tunnels: TunnelEntry[]): SqlnestConfig {
	const salt = generateSalt();
	const kp = generateKeypair();
	const cfg: SqlnestConfig = {
		version: CONFIG_VERSION,
		salt,
		keypair: {
			public: kp.publicHex,
			encrypted_private: encryptPrivateKey(kp.privateHex, salt)
		},
		tunnels
	};
	saveConfig(cfg);
	return cfg;
}

function makeTunnel(overrides: Partial<TunnelEntry> = {}): TunnelEntry {
	return {
		id: overrides.id ?? "11111111-1111-1111-1111-111111111111",
		name: overrides.name ?? "prod",
		connection_id:
			overrides.connection_id ?? "22222222-2222-2222-2222-222222222222",
		session_token: overrides.session_token ?? `tn_${"a".repeat(64)}`,
		expires_at: overrides.expires_at ?? "2026-09-06T12:00:00.000Z"
	};
}

let tempDir: string;

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "sqlnest-logout-test-"));
	process.env.SQLNEST_CONFIG_DIR = tempDir;
});

afterEach(() => {
	delete process.env.SQLNEST_CONFIG_DIR;
	if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
});

describe("logout", () => {
	test("ni --all ni --tunnel → throw explicite", () => {
		expect(() => logout({})).toThrow(/all|tunnel/);
	});

	test("--all sans config → { removed: 0 }", () => {
		expect(logout({ all: true })).toEqual({ removed: 0 });
	});

	test("--tunnel <id> retire uniquement cette entrée", () => {
		seedConfig([
			makeTunnel({ id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", name: "prod" }),
			makeTunnel({
				id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
				name: "staging"
			})
		]);

		const res = logout({ tunnelId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" });
		expect(res).toEqual({ removed: 1 });

		const cfg = loadConfig();
		expect(cfg?.tunnels.length).toBe(1);
		expect(cfg?.tunnels[0]?.name).toBe("staging");
	});

	test("--tunnel id inconnu → { removed: 0 } et config intacte", () => {
		seedConfig([makeTunnel()]);
		const res = logout({ tunnelId: "00000000-0000-0000-0000-000000000000" });
		expect(res).toEqual({ removed: 0 });

		const cfg = loadConfig();
		expect(cfg?.tunnels.length).toBe(1);
	});

	test("--all vide config.tunnels[] et laisse keypair intacte", () => {
		const seeded = seedConfig([
			makeTunnel({ id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" }),
			makeTunnel({ id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" })
		]);

		const res = logout({ all: true });
		expect(res).toEqual({ removed: 2 });

		const cfg = loadConfig();
		expect(cfg?.tunnels).toEqual([]);
		// Keypair pas touchée.
		expect(cfg?.keypair.public).toBe(seeded.keypair.public);
		expect(cfg?.keypair.encrypted_private).toBe(
			seeded.keypair.encrypted_private
		);
		expect(cfg?.salt).toBe(seeded.salt);
	});

	test("--all sur config déjà vide → { removed: 0 }, pas de rewrite", () => {
		seedConfig([]);
		const res = logout({ all: true });
		expect(res).toEqual({ removed: 0 });
		expect(loadConfig()?.tunnels).toEqual([]);
	});
});
