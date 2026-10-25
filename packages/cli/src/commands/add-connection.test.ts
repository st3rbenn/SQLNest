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
} from "../services/local-connections";
import type { Prompter } from "../ui/prompts";
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

	test("--url mssql:// (et alias sqlserver://) acceptée telle quelle", async () => {
		const prompter = mockPrompter({});
		await addConnection({
			name: "chinook-mssql",
			url: "mssql://sa:pw@localhost:1433/Chinook?trustServerCertificate=true",
			prompter,
			stdout: (l) => out.push(l)
		});
		expect(loadLocalConnections()?.connections[0]?.url).toBe(
			"mssql://sa:pw@localhost:1433/Chinook?trustServerCertificate=true"
		);

		const prompter2 = mockPrompter({});
		await addConnection({
			name: "legacy-2014",
			url: "sqlserver://u:p@corp-host:1433/prod",
			prompter: prompter2,
			stdout: (l) => out.push(l)
		});
		expect(
			loadLocalConnections()?.connections.map((c) => c.url)
		).toContain("sqlserver://u:p@corp-host:1433/prod");
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
	test("select mongodb + authSource vide → DSN sans query (default=db)", async () => {
		const prompter = mockPrompter({
			engine: "mongodb",
			// Ordre : host, port, database, user, [password], authSource (vide)
			lines: ["localhost", "27017", "test", "myuser", ""],
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

	test("mongodb + authSource=admin → ?authSource=admin dans la DSN", async () => {
		const prompter = mockPrompter({
			engine: "mongodb",
			lines: ["localhost", "27017", "sqlnest_demo", "sqlnest", "admin"],
			password: "sqlnest"
		});
		await addConnection({
			name: "mongo-admin",
			prompter,
			stdout: (l) => out.push(l)
		});
		const file = loadLocalConnections();
		expect(file?.connections[0]?.url).toBe(
			"mongodb://sqlnest:sqlnest@localhost:27017/sqlnest_demo?authSource=admin"
		);
	});

	test("mongodb + user vide → DSN anonyme, pas de prompt authSource", async () => {
		const prompter = mockPrompter({
			engine: "mongodb",
			lines: ["localhost", "27017", "test", ""] // user vide → skip password + skip authSource
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
			lines: ["localhost", "", "test", ""] // port vide, user vide (skip pw + authSource)
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

describe("addConnection — setup intelligent (ADR-038 E/2b1)", () => {
	const okProbe = vi.fn(async () => ({
		latencyMs: 2,
		serverVersion: "PostgreSQL 16.13 on aarch64-unknown-linux-musl",
		collectionCount: 11
	}));

	test("--url JDBC sans --name : URL normalisée, nom proposé, connexion testée", async () => {
		const res = await addConnection({
			url: "jdbc:postgresql://localhost:5433/chinook?user=postgres&password=pw",
			test: okProbe,
			prompter: mockPrompter({}),
			stdout: (l) => out.push(l)
		});
		expect(res).toEqual({ name: "chinook", overwritten: false });
		expect(okProbe).toHaveBeenCalledWith(
			"postgres://postgres:pw@localhost:5433/chinook"
		);
		expect(loadLocalConnections()?.connections).toEqual([
			{ name: "chinook", url: "postgres://postgres:pw@localhost:5433/chinook" }
		]);
		expect(out[0]).toBe("✓ PostgreSQL 16.13 — 11 tables");
		expect(out.join("\n")).not.toContain("pw@");
	});

	test("nom proposé déjà pris → suffixe, sans question d'écrasement", async () => {
		saveLocalConnections({
			version: LOCAL_CONNECTIONS_VERSION,
			connections: [
				{ name: "Chinook", url: "postgres://a@b/c" },
				{ name: "chinook", url: "postgres://a@b/c" }
			]
		});
		const res = await addConnection({
			url: "Server=localhost,1433;Database=Chinook;User Id=sa;Password=x;TrustServerCertificate=True",
			prompter: mockPrompter({}),
			stdout: (l) => out.push(l)
		});
		expect(res.name).toBe("chinook-2");
		expect(loadLocalConnections()?.connections.at(-1)).toEqual({
			name: "chinook-2",
			url: "mssql://sa:x@localhost:1433/Chinook?trustServerCertificate=true"
		});
	});

	test("base injoignable : refus d'enregistrer quand même → rien n'est écrit", async () => {
		const failing = vi.fn(async () => {
			throw new Error("connect ECONNREFUSED 127.0.0.1:5999");
		});
		await expect(
			addConnection({
				name: "down",
				url: "postgres://u:p@localhost:5999/x",
				test: failing,
				prompter: mockPrompter({ confirms: [false] }),
				stdout: (l) => out.push(l)
			})
		).rejects.toMatchObject({ kind: "cancelled" });
		expect(out).toContain(
			"✗ Connexion impossible : connect ECONNREFUSED 127.0.0.1:5999"
		);
		expect(loadLocalConnections()).toBeNull();
	});

	test("base injoignable : enregistrer quand même → écrit", async () => {
		const failing = vi.fn(async () => {
			throw new Error("timeout");
		});
		await addConnection({
			name: "later",
			url: "postgres://u:p@localhost:5999/x",
			test: failing,
			prompter: mockPrompter({ confirms: [true] }),
			stdout: (l) => out.push(l)
		});
		expect(loadLocalConnections()?.connections).toEqual([
			{ name: "later", url: "postgres://u:p@localhost:5999/x" }
		]);
	});

	test("remplacer l'URL d'une connexion garde son projet relié", async () => {
		saveLocalConnections({
			version: 2,
			connections: [
				{
					name: "apollon",
					url: "postgres://old@localhost/apollon",
					project: { path: "/srv/apollon", orm: "prisma", apply: true }
				}
			]
		});
		await addConnection({
			name: "apollon",
			force: true,
			url: "postgres://new@localhost:5436/apollon",
			prompter: mockPrompter({}),
			stdout: (l) => out.push(l)
		});
		expect(loadLocalConnections()?.connections).toEqual([
			{
				name: "apollon",
				url: "postgres://new@localhost:5436/apollon",
				project: { path: "/srv/apollon", orm: "prisma", apply: true }
			}
		]);
	});
});

describe("addConnection — sans terminal (ADR-038 E/2b1)", () => {
	test("base injoignable, stdin redirigé : échec sans question, cause du pilote et --no-test indiqués", async () => {
		const cause = new Error("connect ECONNREFUSED 127.0.0.1:5999");
		const failing = vi.fn(async () => {
			throw Object.assign(
				new Error(
					"Connexion Postgres échouée (postgres://u:***@localhost:5999/x)"
				),
				{ cause }
			);
		});
		const prompter = mockPrompter({});
		await expect(
			addConnection({
				name: "down",
				url: "postgres://u:p@localhost:5999/x",
				test: failing,
				interactive: false,
				prompter,
				stdout: (l) => out.push(l)
			})
		).rejects.toThrow(
			"Connexion impossible : Connexion Postgres échouée (postgres://u:***@localhost:5999/x) — connect ECONNREFUSED 127.0.0.1:5999 — relance avec --no-test pour l'enregistrer sans la tester."
		);
		expect(prompter.confirm).not.toHaveBeenCalled();
		expect(loadLocalConnections()).toBeNull();
	});
});

test("cause AggregateError (IPv6 + IPv4) : erreurs internes affichées", async () => {
	const cause = Object.assign(
		new AggregateError([
			new Error("connect ECONNREFUSED ::1:5999"),
			new Error("connect ECONNREFUSED 127.0.0.1:5999")
		]),
		{ message: "" }
	);
	const failing = vi.fn(async () => {
		throw Object.assign(new Error("Connexion Postgres échouée"), { cause });
	});
	await expect(
		addConnection({
			name: "down",
			url: "postgres://u:p@localhost:5999/x",
			test: failing,
			interactive: false,
			prompter: mockPrompter({}),
			stdout: (l) => out.push(l)
		})
	).rejects.toThrow(
		"Connexion Postgres échouée — connect ECONNREFUSED ::1:5999, connect ECONNREFUSED 127.0.0.1:5999"
	);
});
