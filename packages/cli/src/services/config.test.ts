/**
 * Tests unit — module config CLI.
 *
 * Chaque test utilise un dossier temp isolé via `SQLNEST_CONFIG_DIR`.
 * Le teardown supprime le dossier — pas de pollution entre tests.
 */

import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	CONFIG_VERSION,
	getConfigDir,
	getConfigPath,
	loadConfig,
	type SqlnestConfig,
	saveConfig
} from "./config";
import { encryptPrivateKey, generateKeypair, generateSalt } from "./crypto";

// Helper — build a valid config with fresh keypair/salt.
function makeValidConfig(): SqlnestConfig {
	const salt = generateSalt();
	const kp = generateKeypair();
	return {
		version: CONFIG_VERSION,
		salt,
		keypair: {
			public: kp.publicHex,
			encrypted_private: encryptPrivateKey(kp.privateHex, salt)
		},
		tunnels: []
	};
}

describe("config load/save", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "sqlnest-cli-test-"));
		process.env.SQLNEST_CONFIG_DIR = tempDir;
	});

	afterEach(() => {
		delete process.env.SQLNEST_CONFIG_DIR;
		if (existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test("loadConfig sur fichier absent → null", () => {
		expect(loadConfig()).toBeNull();
	});

	test("saveConfig → loadConfig round-trip", () => {
		const config = makeValidConfig();
		saveConfig(config);

		const loaded = loadConfig();
		expect(loaded).not.toBeNull();
		expect(loaded?.version).toBe(CONFIG_VERSION);
		expect(loaded?.salt).toBe(config.salt);
		expect(loaded?.keypair.public).toBe(config.keypair.public);
		expect(loaded?.keypair.encrypted_private).toBe(
			config.keypair.encrypted_private
		);
		expect(loaded?.tunnels).toEqual([]);
	});

	test("saveConfig — perms 0600 posées", () => {
		saveConfig(makeValidConfig());
		const path = getConfigPath();
		const perms = statSync(path).mode & 0o777;
		expect(perms).toBe(0o600);
	});

	test("saveConfig — répertoire créé si absent", () => {
		expect(existsSync(getConfigDir())).toBe(true);
		// Supprime le dossier + relance : saveConfig recrée.
		rmSync(tempDir, { recursive: true, force: true });
		expect(existsSync(getConfigDir())).toBe(false);
		saveConfig(makeValidConfig());
		expect(existsSync(getConfigDir())).toBe(true);
		expect(existsSync(getConfigPath())).toBe(true);
	});

	test("loadConfig refuse perms trop permissives (0644)", () => {
		saveConfig(makeValidConfig());
		chmodSync(getConfigPath(), 0o644);
		expect(() => loadConfig()).toThrow(/permissions|chmod/i);
	});

	test("loadConfig refuse version inconnue", () => {
		const config = makeValidConfig();
		saveConfig(config);
		// Écrase le fichier en changeant la version.
		const path = getConfigPath();
		const raw = readFileSync(path, "utf8");
		writeFileSync(
			path,
			raw.replace(`version = ${CONFIG_VERSION}`, "version = 99"),
			{ mode: 0o600 }
		);
		expect(() => loadConfig()).toThrow(/version/i);
	});

	test("loadConfig refuse salt malformé", () => {
		const raw = `version = ${CONFIG_VERSION}
salt = "not-hex"

[keypair]
public = "${"a".repeat(64)}"
encrypted_private = "${"b".repeat(120)}"

tunnels = []
`;
		writeFileSync(getConfigPath(), raw, { mode: 0o600 });
		expect(() => loadConfig()).toThrow(/salt/i);
	});

	test("loadConfig refuse pubkey mal formée", () => {
		const raw = `version = ${CONFIG_VERSION}
salt = "${generateSalt()}"

[keypair]
public = "too-short"
encrypted_private = "${"b".repeat(120)}"

tunnels = []
`;
		writeFileSync(getConfigPath(), raw, { mode: 0o600 });
		expect(() => loadConfig()).toThrow(/pubkey|public/i);
	});

	test("saveConfig avec tunnels — round-trip inclut `last_used` optionnel", () => {
		const config: SqlnestConfig = {
			...makeValidConfig(),
			tunnels: [
				{
					id: "11111111-1111-1111-1111-111111111111",
					name: "prod",
					connection_id: "22222222-2222-2222-2222-222222222222",
					session_token: `tn_${"c".repeat(64)}`,
					expires_at: "2026-09-06T12:00:00.000Z",
					last_used: "2026-08-06T15:00:00.000Z"
				},
				{
					id: "33333333-3333-3333-3333-333333333333",
					name: "staging",
					connection_id: "44444444-4444-4444-4444-444444444444",
					session_token: `tn_${"d".repeat(64)}`,
					expires_at: "2026-09-06T12:00:00.000Z"
				}
			]
		};
		saveConfig(config);
		const loaded = loadConfig();
		expect(loaded?.tunnels.length).toBe(2);
		expect(loaded?.tunnels[0]?.name).toBe("prod");
		expect(loaded?.tunnels[0]?.last_used).toBe("2026-08-06T15:00:00.000Z");
		expect(loaded?.tunnels[1]?.name).toBe("staging");
		expect(loaded?.tunnels[1]?.last_used).toBeUndefined();
	});
});
