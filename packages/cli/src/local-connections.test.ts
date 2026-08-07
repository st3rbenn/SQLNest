/**
 * Tests unit — module local-connections (résolution DSN Postgres locales).
 *
 * Cible :
 *   - load/save round-trip.
 *   - refus perms > 0600.
 *   - refus version inconnue, duplicates, format cassé.
 *   - `resolveLocalConnectionUrl` : ordre de priorité (env per-tunnel >
 *     env fallback > fichier).
 *   - `describeConnectionForDiagnostics` : SAFE, jamais la DSN.
 */

import { chmodSync, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	describeConnectionForDiagnostics,
	getLocalConnectionsPath,
	LOCAL_CONNECTIONS_VERSION,
	LocalConnectionNotFoundError,
	loadLocalConnections,
	resolveLocalConnectionUrl,
	saveLocalConnections
} from "./local-connections";

let tempDir: string;

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "sqlnest-locconn-test-"));
	process.env.SQLNEST_CONFIG_DIR = tempDir;
	// Isole les tests des vraies env vars du shell qui lance vitest.
	delete process.env.SQLNEST_PG_URL;
	delete process.env.SQLNEST_PG_URL_PROD;
	delete process.env.SQLNEST_PG_URL_STAGING;
});

afterEach(() => {
	delete process.env.SQLNEST_CONFIG_DIR;
	delete process.env.SQLNEST_PG_URL;
	delete process.env.SQLNEST_PG_URL_PROD;
	delete process.env.SQLNEST_PG_URL_STAGING;
	if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
});

describe("load/save round-trip", () => {
	test("loadLocalConnections sur fichier absent → null", () => {
		expect(loadLocalConnections()).toBeNull();
	});

	test("saveLocalConnections → perms 0600 posées", () => {
		saveLocalConnections({
			version: LOCAL_CONNECTIONS_VERSION,
			connections: [{ name: "prod", url: "postgres://u:p@localhost:5432/db" }]
		});
		const perms = statSync(getLocalConnectionsPath()).mode & 0o777;
		expect(perms).toBe(0o600);
	});

	test("save → load round-trip conservé", () => {
		const file = {
			version: LOCAL_CONNECTIONS_VERSION,
			connections: [
				{ name: "prod", url: "postgres://a@localhost/dbA" },
				{ name: "staging", url: "postgres://b@localhost/dbB" }
			]
		};
		saveLocalConnections(file);
		const loaded = loadLocalConnections();
		expect(loaded?.version).toBe(LOCAL_CONNECTIONS_VERSION);
		expect(loaded?.connections.length).toBe(2);
		expect(loaded?.connections[0]?.name).toBe("prod");
		expect(loaded?.connections[1]?.name).toBe("staging");
	});

	test("refuse perms trop permissives (0644)", () => {
		saveLocalConnections({
			version: LOCAL_CONNECTIONS_VERSION,
			connections: [{ name: "prod", url: "postgres://x@y/z" }]
		});
		chmodSync(getLocalConnectionsPath(), 0o644);
		expect(() => loadLocalConnections()).toThrow(/permissions|chmod/i);
	});
});

describe("resolveLocalConnectionUrl — priorités", () => {
	test("env per-tunnel prioritaire sur env fallback et fichier", () => {
		process.env.SQLNEST_PG_URL_PROD = "postgres://per-tunnel@a/b";
		process.env.SQLNEST_PG_URL = "postgres://fallback@a/b";
		saveLocalConnections({
			version: LOCAL_CONNECTIONS_VERSION,
			connections: [{ name: "prod", url: "postgres://file@a/b" }]
		});
		expect(resolveLocalConnectionUrl("prod")).toBe("postgres://per-tunnel@a/b");
	});

	test("env fallback si per-tunnel absent", () => {
		process.env.SQLNEST_PG_URL = "postgres://fallback@a/b";
		saveLocalConnections({
			version: LOCAL_CONNECTIONS_VERSION,
			connections: [{ name: "prod", url: "postgres://file@a/b" }]
		});
		expect(resolveLocalConnectionUrl("prod")).toBe("postgres://fallback@a/b");
	});

	test("fichier si aucune env n'est set", () => {
		saveLocalConnections({
			version: LOCAL_CONNECTIONS_VERSION,
			connections: [{ name: "prod", url: "postgres://file@a/b" }]
		});
		expect(resolveLocalConnectionUrl("prod")).toBe("postgres://file@a/b");
	});

	test("aucune source → LocalConnectionNotFoundError avec suggestions env", () => {
		expect(() => resolveLocalConnectionUrl("prod")).toThrow(
			LocalConnectionNotFoundError
		);
		try {
			resolveLocalConnectionUrl("prod");
			throw new Error("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(LocalConnectionNotFoundError);
			expect((err as LocalConnectionNotFoundError).perTunnelEnvKey).toBe(
				"SQLNEST_PG_URL_PROD"
			);
			expect((err as Error).message).toMatch(/SQLNEST_PG_URL_PROD/);
			expect((err as Error).message).toMatch(/local-connections\.toml/);
		}
	});

	test("nom avec dash / caractères non-alphanum → normalisé pour env key", () => {
		process.env["SQLNEST_PG_URL_MY_CI_1"] = "postgres://match@a/b";
		expect(resolveLocalConnectionUrl("my-ci-1")).toBe("postgres://match@a/b");
	});
});

describe("describeConnectionForDiagnostics — SAFE (jamais la DSN)", () => {
	test("source `env-per-tunnel`", () => {
		process.env.SQLNEST_PG_URL_PROD = "postgres://secret@a/b";
		const info = describeConnectionForDiagnostics("prod");
		expect(info).toEqual({ name: "prod", source: "env-per-tunnel" });
		// Assertion sécu critique : la DSN n'apparaît PAS dans l'objet.
		const raw = JSON.stringify(info);
		expect(raw).not.toContain("secret");
		expect(raw).not.toContain("postgres://");
	});

	test("source `env-fallback`", () => {
		process.env.SQLNEST_PG_URL = "postgres://user:supersecret@a/b";
		const info = describeConnectionForDiagnostics("prod");
		expect(info.source).toBe("env-fallback");
		expect(JSON.stringify(info)).not.toContain("supersecret");
	});

	test("source `local-file`", () => {
		saveLocalConnections({
			version: LOCAL_CONNECTIONS_VERSION,
			connections: [{ name: "prod", url: "postgres://filesecret@a/b" }]
		});
		const info = describeConnectionForDiagnostics("prod");
		expect(info.source).toBe("local-file");
		expect(JSON.stringify(info)).not.toContain("filesecret");
	});
});

describe("format validation", () => {
	test("version inconnue → throw", () => {
		saveLocalConnections({
			version: LOCAL_CONNECTIONS_VERSION,
			connections: [{ name: "prod", url: "postgres://a@b/c" }]
		});
		// Ré-écrit avec version bidon.
		const { writeFileSync, readFileSync } = require("node:fs");
		const path = getLocalConnectionsPath();
		const raw = readFileSync(path, "utf8") as string;
		writeFileSync(
			path,
			raw.replace(`version = ${LOCAL_CONNECTIONS_VERSION}`, "version = 99"),
			{ mode: 0o600 }
		);
		expect(() => loadLocalConnections()).toThrow(/version/i);
	});

	test("nom dupliqué → throw", () => {
		const path = getLocalConnectionsPath();
		const { writeFileSync, mkdirSync } = require("node:fs");
		mkdirSync(tempDir, { recursive: true, mode: 0o700 });
		const raw = `version = ${LOCAL_CONNECTIONS_VERSION}

[[connections]]
name = "prod"
url = "postgres://a@b/c"

[[connections]]
name = "prod"
url = "postgres://x@y/z"
`;
		writeFileSync(path, raw, { mode: 0o600 });
		expect(() => loadLocalConnections()).toThrow(/double|duplicate/i);
	});
});
