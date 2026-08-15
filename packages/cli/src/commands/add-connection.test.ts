/**
 * Tests unit — `sqlnest add-connection`.
 *
 * Injection totale : `Prompter` mocké (queue de réponses) + tmpdir isolé
 * via `SQLNEST_CONFIG_DIR`. Aucun test réel du raw-mode terminal — la
 * mécanique OS-dependent des prompts vit dans `prompts.ts` et n'est pas
 * unit-testée (validation manuelle CLI).
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	LOCAL_CONNECTIONS_VERSION,
	loadLocalConnections,
	saveLocalConnections
} from "../local-connections";
import type { Prompter } from "../prompts";
import { AddConnectionError, addConnection } from "./add-connection";

interface MockResponses {
	lines?: string[];
	password?: string;
	confirms?: boolean[];
	/** Engine renvoyé par le prompt select. Par défaut postgres (backward
	 *  compat avec les tests écrits avant l'ajout du prompt engine). */
	engine?: "postgres" | "mongodb";
}

function mockPrompter(responses: MockResponses): Prompter {
	const lineQueue = [...(responses.lines ?? [])];
	const confirmQueue = [...(responses.confirms ?? [])];
	const engine = responses.engine ?? "postgres";
	return {
		line: vi.fn(async () => {
			const next = lineQueue.shift();
			if (next === undefined) {
				throw new Error("mockPrompter: line queue vide");
			}
			return next;
		}),
		password: vi.fn(async () => responses.password ?? ""),
		confirm: vi.fn(async () => {
			const next = confirmQueue.shift();
			if (next === undefined) {
				throw new Error("mockPrompter: confirm queue vide");
			}
			return next;
		}),
		select: vi.fn(async () => engine)
	};
}

let tempDir: string;
let out: string[];

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "sqlnest-add-conn-test-"));
	process.env.SQLNEST_CONFIG_DIR = tempDir;
	out = [];
});

afterEach(() => {
	delete process.env.SQLNEST_CONFIG_DIR;
	if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
});

describe("addConnection — happy path (nouvelle entrée)", () => {
	test("prompts host/port/db/user + password → écrit dans le fichier", async () => {
		const prompter = mockPrompter({
			lines: ["localhost", "5432", "apollon", "myuser"],
			password: "s3cret!"
		});

		const res = await addConnection({
			name: "apollon",
			prompter,
			stdout: (l) => out.push(l)
		});

		expect(res).toEqual({ name: "apollon", overwritten: false });

		const file = loadLocalConnections();
		expect(file?.connections.length).toBe(1);
		expect(file?.connections[0]?.name).toBe("apollon");
		expect(file?.connections[0]?.url).toBe(
			"postgres://myuser:s3cret!@localhost:5432/apollon"
		);
		expect(out.some((l) => /ajoutée/.test(l))).toBe(true);
	});

	test("password avec caractères spéciaux → URI-encoded dans la DSN", async () => {
		const prompter = mockPrompter({
			lines: ["h", "5432", "d", "u"],
			password: "p@ss:w/rd"
		});
		await addConnection({
			name: "x",
			prompter,
			stdout: (l) => out.push(l)
		});
		const file = loadLocalConnections();
		// Encodés : @ → %40, : → %3A, / → %2F
		expect(file?.connections[0]?.url).toBe(
			"postgres://u:p%40ss%3Aw%2Frd@h:5432/d"
		);
	});
});

describe("addConnection — overwrite", () => {
	test("entrée existante + confirm=y → remplace", async () => {
		saveLocalConnections({
			version: LOCAL_CONNECTIONS_VERSION,
			connections: [{ name: "prod", url: "postgres://old@h/db" }]
		});
		const prompter = mockPrompter({
			confirms: [true],
			lines: ["newhost", "5432", "newdb", "newuser"],
			password: "newpass"
		});

		const res = await addConnection({
			name: "prod",
			prompter,
			stdout: (l) => out.push(l)
		});

		expect(res.overwritten).toBe(true);
		const file = loadLocalConnections();
		expect(file?.connections.length).toBe(1);
		expect(file?.connections[0]?.url).toContain("newhost");
		expect(out.some((l) => /remplacée/.test(l))).toBe(true);
	});

	test("entrée existante + confirm=n → throw cancelled, fichier intact", async () => {
		saveLocalConnections({
			version: LOCAL_CONNECTIONS_VERSION,
			connections: [{ name: "prod", url: "postgres://old@h/db" }]
		});
		const prompter = mockPrompter({ confirms: [false] });

		await expect(
			addConnection({
				name: "prod",
				prompter,
				stdout: (l) => out.push(l)
			})
		).rejects.toThrow(AddConnectionError);

		const file = loadLocalConnections();
		expect(file?.connections[0]?.url).toBe("postgres://old@h/db");
	});

	test("--force → skip confirm, écrase directement", async () => {
		saveLocalConnections({
			version: LOCAL_CONNECTIONS_VERSION,
			connections: [{ name: "prod", url: "postgres://old@h/db" }]
		});
		const prompter = mockPrompter({
			lines: ["h2", "5432", "d2", "u2"],
			password: "p2"
		});

		const res = await addConnection({
			name: "prod",
			force: true,
			prompter,
			stdout: (l) => out.push(l)
		});

		expect(res.overwritten).toBe(true);
		expect(prompter.confirm).not.toHaveBeenCalled();
	});
});

describe("addConnection — validation d'input", () => {
	test("host vide → throw invalid-input", async () => {
		const prompter = mockPrompter({
			lines: ["", "5432", "d", "u"],
			password: "p"
		});
		await expect(
			addConnection({
				name: "x",
				prompter,
				stdout: (l) => out.push(l)
			})
		).rejects.toMatchObject({
			name: "AddConnectionError",
			kind: "invalid-input"
		});
	});

	test("port non-numérique → throw invalid-input", async () => {
		const prompter = mockPrompter({
			lines: ["h", "abc", "d", "u"],
			password: "p"
		});
		await expect(
			addConnection({
				name: "x",
				prompter,
				stdout: (l) => out.push(l)
			})
		).rejects.toMatchObject({ kind: "invalid-input" });
	});

	test("port hors bornes → throw invalid-input", async () => {
		const prompter = mockPrompter({
			lines: ["h", "99999", "d", "u"],
			password: "p"
		});
		await expect(
			addConnection({
				name: "x",
				prompter,
				stdout: (l) => out.push(l)
			})
		).rejects.toMatchObject({ kind: "invalid-input" });
	});

	test("password vide → throw invalid-input", async () => {
		const prompter = mockPrompter({
			lines: ["h", "5432", "d", "u"],
			password: ""
		});
		await expect(
			addConnection({
				name: "x",
				prompter,
				stdout: (l) => out.push(l)
			})
		).rejects.toMatchObject({ kind: "invalid-input" });
	});
});

describe("addConnection — mode --url (DSN inline)", () => {
	test("URL valide → skip tous les prompts, écrit direct", async () => {
		const prompter = mockPrompter({});
		const res = await addConnection({
			name: "apollon",
			url: "postgresql://postgres:root@localhost:5432/apollon-db",
			prompter,
			stdout: (l) => out.push(l)
		});
		expect(res).toEqual({ name: "apollon", overwritten: false });
		expect(prompter.line).not.toHaveBeenCalled();
		expect(prompter.password).not.toHaveBeenCalled();
		const file = loadLocalConnections();
		expect(file?.connections[0]?.url).toBe(
			"postgresql://postgres:root@localhost:5432/apollon-db"
		);
	});

	test("URL invalide (pas de schéma reconnu) → throw invalid-input", async () => {
		const prompter = mockPrompter({});
		await expect(
			addConnection({
				name: "x",
				url: "not-a-dsn",
				prompter,
				stdout: (l) => out.push(l)
			})
		).rejects.toMatchObject({ kind: "invalid-input" });
	});

	test("URL mongodb+srv:// acceptée", async () => {
		const prompter = mockPrompter({});
		await addConnection({
			name: "atlas",
			url: "mongodb+srv://u:p@cluster.mongodb.net/db",
			prompter,
			stdout: (l) => out.push(l)
		});
		expect(loadLocalConnections()?.connections[0]?.url).toContain(
			"mongodb+srv://"
		);
	});

	test("--url + entrée existante → prompt overwrite, PUIS skip inputs", async () => {
		saveLocalConnections({
			version: LOCAL_CONNECTIONS_VERSION,
			connections: [{ name: "prod", url: "postgres://old@h/db" }]
		});
		const prompter = mockPrompter({ confirms: [true] });
		const res = await addConnection({
			name: "prod",
			url: "postgres://new@h/db",
			prompter,
			stdout: (l) => out.push(l)
		});
		expect(res.overwritten).toBe(true);
		expect(prompter.line).not.toHaveBeenCalled();
	});
});

describe("addConnection — coexistence entrées", () => {
	test("2e connection ajoutée → les 2 coexistent", async () => {
		saveLocalConnections({
			version: LOCAL_CONNECTIONS_VERSION,
			connections: [{ name: "prod", url: "postgres://prod-url" }]
		});
		const prompter = mockPrompter({
			lines: ["h", "5432", "d", "u"],
			password: "p"
		});
		await addConnection({
			name: "staging",
			prompter,
			stdout: (l) => out.push(l)
		});

		const file = loadLocalConnections();
		expect(file?.connections.length).toBe(2);
		expect(file?.connections.map((c) => c.name).sort()).toEqual([
			"prod",
			"staging"
		]);
	});
});

describe("addConnection — engine mongodb", () => {
	test("select mongodb → DSN mongodb:// avec port par défaut acceptable", async () => {
		const prompter = mockPrompter({
			engine: "mongodb",
			lines: ["localhost", "27017", "test", "myuser"],
			password: "pw"
		});
		await addConnection({
			name: "mongo-dev",
			prompter,
			stdout: (l) => out.push(l)
		});
		const file = loadLocalConnections();
		expect(file?.connections[0]?.url).toBe(
			"mongodb://myuser:pw@localhost:27017/test"
		);
	});

	test("mongodb + user vide → DSN anonyme (mongodb://host:port/db)", async () => {
		const prompter = mockPrompter({
			engine: "mongodb",
			lines: ["localhost", "27017", "test", ""] // user vide → skip password
		});
		await addConnection({
			name: "mongo-anon",
			prompter,
			stdout: (l) => out.push(l)
		});
		const file = loadLocalConnections();
		expect(file?.connections[0]?.url).toBe("mongodb://localhost:27017/test");
		// Password non demandé quand user est vide.
		expect(prompter.password).not.toHaveBeenCalled();
	});

	test("port vide → default du engine (27017 pour mongo)", async () => {
		const prompter = mockPrompter({
			engine: "mongodb",
			lines: ["localhost", "", "test", ""] // port vide
		});
		await addConnection({
			name: "mongo-default-port",
			prompter,
			stdout: (l) => out.push(l)
		});
		const file = loadLocalConnections();
		expect(file?.connections[0]?.url).toBe("mongodb://localhost:27017/test");
	});

	test("postgres + user vide → refus (user obligatoire)", async () => {
		const prompter = mockPrompter({
			engine: "postgres",
			lines: ["localhost", "5432", "db", ""]
		});
		await expect(
			addConnection({
				name: "pg-anon",
				prompter,
				stdout: (l) => out.push(l)
			})
		).rejects.toBeInstanceOf(AddConnectionError);
	});
});
