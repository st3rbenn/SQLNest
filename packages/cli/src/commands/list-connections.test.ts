/**
 * Tests unit — `sqlnest list-connections`.
 *
 * Vérifie que la sortie contient bien le shape `NAME · ENGINE · LOCATION`
 * mais JAMAIS le user ni le password (règle sécu SQLNest : les creds ne
 * sortent pas du fichier local).
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	LOCAL_CONNECTIONS_VERSION,
	saveLocalConnections
} from "../local-connections";
import { listConnections } from "./list-connections";

let tempDir: string;
let out: string[];

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "sqlnest-list-conn-test-"));
	process.env.SQLNEST_CONFIG_DIR = tempDir;
	out = [];
});

afterEach(() => {
	delete process.env.SQLNEST_CONFIG_DIR;
	if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
});

describe("listConnections", () => {
	test("fichier absent → message d'onboarding", () => {
		listConnections({ stdout: (l) => out.push(l) });
		expect(out.join("\n")).toContain("Aucune connexion enregistrée");
		expect(out.join("\n")).toContain("sqlnest add-connection");
	});

	test("fichier vide (0 connections) → même message", () => {
		saveLocalConnections({
			version: LOCAL_CONNECTIONS_VERSION,
			connections: []
		});
		listConnections({ stdout: (l) => out.push(l) });
		expect(out.join("\n")).toContain("Aucune connexion enregistrée");
	});

	test("liste PG + Mongo → NAME/ENGINE/LOCATION, jamais de creds", () => {
		saveLocalConnections({
			version: LOCAL_CONNECTIONS_VERSION,
			connections: [
				{ name: "apollon", url: "postgres://myuser:s3cret@localhost:5432/apollon" },
				{ name: "mongo-dev", url: "mongodb://mongouser:mongopass@localhost:27017/test" }
			]
		});
		listConnections({ stdout: (l) => out.push(l) });
		const joined = out.join("\n");

		// Header
		expect(joined).toContain("NAME");
		expect(joined).toContain("ENGINE");
		expect(joined).toContain("LOCATION");

		// Rows
		expect(joined).toContain("apollon");
		expect(joined).toContain("postgres");
		expect(joined).toContain("localhost:5432/apollon");

		expect(joined).toContain("mongo-dev");
		expect(joined).toContain("mongodb");
		expect(joined).toContain("localhost:27017/test");

		// CRITIQUE : jamais de creds dans la sortie
		expect(joined).not.toContain("myuser");
		expect(joined).not.toContain("s3cret");
		expect(joined).not.toContain("mongouser");
		expect(joined).not.toContain("mongopass");
	});

	test("DSN sans port explicite → port par défaut du engine dans la sortie", () => {
		saveLocalConnections({
			version: LOCAL_CONNECTIONS_VERSION,
			connections: [{ name: "pg", url: "postgres://u:p@h/db" }]
		});
		listConnections({ stdout: (l) => out.push(l) });
		expect(out.join("\n")).toContain("h:5432/db");
	});

	test("DSN opaque (mal formée) → n'écroule pas la commande", () => {
		saveLocalConnections({
			version: LOCAL_CONNECTIONS_VERSION,
			connections: [{ name: "broken", url: "not-a-valid-url" }]
		});
		listConnections({ stdout: (l) => out.push(l) });
		const joined = out.join("\n");
		expect(joined).toContain("broken");
		expect(joined).toContain("<opaque>");
	});
});
