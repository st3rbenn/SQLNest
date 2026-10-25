/**
 * `sqlnest add-connection` sans argument (ADR-038 S1, S2, S4) : menu des
 * bases découvertes, serveurs listés en direct, référence au `.env`.
 */

import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { parseConnectionString } from "../../services/connection-strings";
import type {
	DiscoveredDatabase,
	DiscoveredServer,
	Discovery
} from "../../services/discovery";
import {
	getLocalConnectionsPath,
	loadLocalConnections,
	saveLocalConnections
} from "../../services/local-connections";
import type { Prompter, SelectChoice, SelectEntry } from "../../ui/prompts";
import { addConnection } from ".";
import { discoveryChoices } from "./discovered";

let tempDir: string;
let out: string[];

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "sqlnest-add-discovered-"));
	process.env.SQLNEST_CONFIG_DIR = tempDir;
	out = [];
});

afterEach(() => {
	delete process.env.SQLNEST_CONFIG_DIR;
	if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
});

/** Le menu choisit la première entrée sélectionnable dont le libellé contient `label`. */
function scriptedPrompter(script: {
	picks: string[];
	lines?: string[];
	password?: string;
	confirms?: boolean[];
}): Prompter & { menus: SelectEntry<unknown>[][] } {
	const picks = [...script.picks];
	const lines = [...(script.lines ?? [])];
	const confirms = [...(script.confirms ?? [])];
	const menus: SelectEntry<unknown>[][] = [];
	return {
		menus,
		line: vi.fn(async () => {
			const next = lines.shift();
			if (next === undefined) throw new Error("line inattendue");
			return next;
		}),
		password: vi.fn(async () => script.password ?? ""),
		confirm: vi.fn(async () => {
			const next = confirms.shift();
			if (next === undefined) throw new Error("confirm inattendu");
			return next;
		}),
		select: vi.fn(async <T>(opts: { choices: readonly SelectEntry<T>[] }) => {
			menus.push([...opts.choices] as SelectEntry<unknown>[]);
			const label = picks.shift();
			const choice = opts.choices.find(
				(c): c is SelectChoice<T> =>
					"value" in c &&
					c.disabled === undefined &&
					c.label.includes(label ?? "")
			);
			if (choice === undefined) throw new Error(`pas de choix « ${label} »`);
			return choice.value;
		}) as Prompter["select"]
	};
}

function database(
	url: string,
	extra: Partial<DiscoveredDatabase> = {}
): DiscoveredDatabase {
	const connection = parseConnectionString(url);
	if (connection === undefined) throw new Error(url);
	return {
		connection,
		source: { kind: "env-file", file: "/p/.env", key: "DATABASE_URL" },
		...extra
	};
}

const LAB_SERVER: DiscoveredServer = {
	engine: "postgres",
	name: "orm-lab-postgres",
	image: "postgres:16-alpine",
	host: "localhost",
	port: 5440,
	user: "lab",
	password: "lab",
	passwordless: false,
	maintenanceDatabase: "lab",
	defaultDatabase: "lab",
	params: {},
	running: true,
	compose: { project: "sqlnest-orm-lab", service: "db" }
};

function discovery(partial: Partial<Discovery>): () => Promise<Discovery> {
	return async () => ({
		root: "/p",
		databases: [],
		projectServers: [],
		servers: [],
		unresolved: [],
		...partial
	});
}

const okProbe = vi.fn(async () => ({
	latencyMs: 1,
	serverVersion: "PostgreSQL 16.13 on x86_64",
	collectionCount: 34
}));

describe("add-connection sans argument", () => {
	test("base d'un .env : testée avec sa valeur, enregistrée en référence, nom proposé", async () => {
		const envFile = join(tempDir, ".env");
		writeFileSync(
			envFile,
			"DATABASE_URL=postgres://lab:lab@localhost:5440/apollon_prisma\n"
		);
		const prompter = scriptedPrompter({
			picks: ["apollon_prisma"],
			lines: [""]
		});
		const res = await addConnection({
			discover: discovery({
				databases: [
					database("postgres://lab:lab@localhost:5440/apollon_prisma", {
						source: { kind: "env-file", file: envFile, key: "DATABASE_URL" },
						urlFrom: { file: envFile, key: "DATABASE_URL" }
					})
				]
			}),
			test: okProbe,
			prompter,
			stdout: (l) => out.push(l)
		});
		expect(res).toEqual({ name: "apollon_prisma", overwritten: false });
		expect(prompter.line).toHaveBeenCalledWith("Nom [apollon_prisma] : ");
		expect(okProbe).toHaveBeenCalledWith(
			"postgres://lab:lab@localhost:5440/apollon_prisma"
		);
		expect(loadLocalConnections()?.connections).toEqual([
			{
				name: "apollon_prisma",
				urlFrom: { file: envFile, key: "DATABASE_URL" }
			}
		]);
		// Le fichier ne contient pas le mot de passe : il relit le .env.
		expect(readFileSync(getLocalConnectionsPath(), "utf8")).not.toContain(
			"lab:lab"
		);
		expect(out).toContain("✓ PostgreSQL 16.13 — 34 tables");
	});

	test("base déjà configurée : grisée avec le nom de la connexion", async () => {
		saveLocalConnections({
			version: 1,
			connections: [
				{ name: "chinook-pg", url: "postgres://u:p@127.0.0.1:5433/Chinook" }
			]
		});
		const prompter = scriptedPrompter({ picks: ["shop"], lines: ["boutique"] });
		await addConnection({
			discover: discovery({
				databases: [
					database("postgresql://other@localhost:5433/chinook"),
					database("postgres://u:p@localhost:5432/shop")
				]
			}),
			prompter,
			stdout: (l) => out.push(l)
		});
		const menu = prompter.menus[0] as SelectChoice<unknown>[];
		const chinook = menu.find(
			(c) => "label" in c && c.label.startsWith("chinook")
		);
		expect(chinook?.disabled).toBe("déjà configurée : chinook-pg");
		expect(loadLocalConnections()?.connections.map((c) => c.name)).toEqual([
			"chinook-pg",
			"boutique"
		]);
	});

	test("serveur Docker : bases listées en direct, déjà configurées grisées, URL copiée", async () => {
		saveLocalConnections({
			version: 1,
			connections: [
				{ name: "lab", url: "postgres://lab:lab@localhost:5440/lab" }
			]
		});
		const listDatabases = vi.fn(async () => [
			"apollon_doctrine",
			"apollon_prisma",
			"lab"
		]);
		const prompter = scriptedPrompter({
			picks: ["orm-lab-postgres", "apollon_doctrine"],
			lines: [""]
		});
		const res = await addConnection({
			discover: discovery({ servers: [LAB_SERVER] }),
			listDatabases,
			prompter,
			stdout: (l) => out.push(l)
		});
		expect(listDatabases).toHaveBeenCalledWith(
			"postgres://lab:lab@localhost:5440/lab"
		);
		const databases = prompter.menus[1] as SelectChoice<unknown>[];
		expect(databases.map((c) => [c.label, c.disabled])).toEqual([
			["apollon_doctrine", undefined],
			["apollon_prisma", undefined],
			["lab", "déjà configurée : lab"]
		]);
		expect(res.name).toBe("apollon_doctrine");
		expect(loadLocalConnections()?.connections.at(-1)).toEqual({
			name: "apollon_doctrine",
			url: "postgres://lab:lab@localhost:5440/apollon_doctrine"
		});
	});

	test("serveur sans mot de passe connu : demandé ; liste illisible : base demandée", async () => {
		const listDatabases = vi.fn(async () => {
			throw new Error('password authentication failed for user "postgres"');
		});
		const prompter = scriptedPrompter({
			picks: ["team-db"],
			password: "t0p",
			lines: ["", "team"]
		});
		await addConnection({
			discover: discovery({
				servers: [
					{
						...LAB_SERVER,
						name: "team-db",
						port: 5499,
						user: "postgres",
						password: undefined,
						maintenanceDatabase: "postgres",
						defaultDatabase: "postgres"
					}
				]
			}),
			listDatabases,
			prompter,
			stdout: (l) => out.push(l)
		});
		expect(prompter.password).toHaveBeenCalledWith(
			"Mot de passe de postgres@localhost:5499 : "
		);
		expect(listDatabases).toHaveBeenCalledWith(
			"postgres://postgres:t0p@localhost:5499/postgres"
		);
		expect(out).toContain(
			'✗ Bases de team-db illisibles : password authentication failed for user "postgres"'
		);
		expect(prompter.line).toHaveBeenCalledWith("Base [postgres] : ");
		expect(loadLocalConnections()?.connections).toEqual([
			{ name: "team", url: "postgres://postgres:t0p@localhost:5499/postgres" }
		]);
	});

	test("une seule base sur le serveur : prise sans menu", async () => {
		const prompter = scriptedPrompter({
			picks: ["orm-lab-postgres"],
			lines: [""]
		});
		await addConnection({
			discover: discovery({ servers: [LAB_SERVER] }),
			listDatabases: async () => ["lab"],
			prompter,
			stdout: (l) => out.push(l)
		});
		expect(prompter.menus).toHaveLength(1);
		expect(out).toContain("Base : lab");
	});

	test("chaîne collée : lue sans écho, décrite sans secret", async () => {
		const prompter = scriptedPrompter({
			picks: ["Coller"],
			password:
				"Server=localhost,1433;Database=Chinook;User Id=sa;Password=S3cr!t;TrustServerCertificate=True",
			lines: [""]
		});
		await addConnection({
			discover: discovery({}),
			prompter,
			stdout: (l) => out.push(l)
		});
		expect(prompter.password).toHaveBeenCalledWith("Chaîne de connexion : ");
		expect(out).toContain(
			"Aucune base trouvée dans ce dossier ni dans Docker."
		);
		expect(out).toContain("SQL Server · sa@localhost:1433/Chinook");
		expect(out.join("\n")).not.toContain("S3cr!t");
		expect(loadLocalConnections()?.connections).toEqual([
			{
				name: "chinook",
				url: "mssql://sa:S3cr!t@localhost:1433/Chinook?trustServerCertificate=true"
			}
		]);
	});

	test("chaîne collée non reconnue → invalid-input, rien d'écrit", async () => {
		await expect(
			addConnection({
				discover: discovery({}),
				prompter: scriptedPrompter({
					picks: ["Coller"],
					password: "mysql://u@h/db"
				}),
				stdout: (l) => out.push(l)
			})
		).rejects.toMatchObject({ kind: "invalid-input" });
		expect(loadLocalConnections()).toBeNull();
	});

	test("saisir à la main : les questions guidées", async () => {
		const prompter = scriptedPrompter({
			picks: ["Saisir", "PostgreSQL"],
			lines: ["localhost", "5432", "app", "me", ""],
			password: "pw"
		});
		await addConnection({
			discover: discovery({}),
			prompter,
			stdout: (l) => out.push(l)
		});
		expect(loadLocalConnections()?.connections).toEqual([
			{ name: "app", url: "postgres://me:pw@localhost:5432/app" }
		]);
	});

	test("nom tapé déjà pris : demande d'écrasement", async () => {
		saveLocalConnections({
			version: 1,
			connections: [{ name: "prod", url: "postgres://old@h/db" }]
		});
		const prompter = scriptedPrompter({
			picks: ["shop"],
			lines: ["prod"],
			confirms: [false]
		});
		await expect(
			addConnection({
				discover: discovery({
					databases: [database("postgres://u:p@localhost:5432/shop")]
				}),
				prompter,
				stdout: (l) => out.push(l)
			})
		).rejects.toMatchObject({ kind: "cancelled" });
		expect(prompter.confirm).toHaveBeenCalledWith(
			"Une entrée « prod » existe déjà. Écraser ? [y/N] "
		);
		expect(loadLocalConnections()?.connections).toEqual([
			{ name: "prod", url: "postgres://old@h/db" }
		]);
	});

	test("sans terminal ni --url : échec qui indique --url, aucune découverte", async () => {
		const discover = vi.fn(discovery({}));
		await expect(
			addConnection({
				discover,
				interactive: false,
				prompter: scriptedPrompter({ picks: [] }),
				stdout: (l) => out.push(l)
			})
		).rejects.toThrow(
			"Sans terminal, passe la chaîne de connexion : sqlnest add-connection --url <chaîne>"
		);
		expect(discover).not.toHaveBeenCalled();
	});
});

describe("add-connection — serveur arrêté (ADR-038 S1)", () => {
	const STOPPED: DiscoveredServer = {
		...LAB_SERVER,
		name: "shop_postgres",
		port: 5436,
		user: "postgres",
		password: "root",
		maintenanceDatabase: "shop-db",
		defaultDatabase: "shop-db",
		running: false,
		container: "shop_postgres"
	};
	const envFile = "/srv/shop/backend/.env";
	const shopDb = (): DiscoveredDatabase =>
		database("postgresql://postgres:root@localhost:5436/shop-db", {
			source: { kind: "env-file", file: envFile, key: "DATABASE_URL" },
			urlFrom: { file: envFile, key: "DATABASE_URL" },
			server: STOPPED
		});

	test("base servie par un conteneur arrêté : démarrage proposé (Entrée = oui), puis enregistrée", async () => {
		const startServer = vi.fn(async () => {});
		const prompter = scriptedPrompter({ picks: ["shop-db"], lines: ["", ""] });
		await addConnection({
			discover: discovery({ databases: [shopDb()], projectServers: [STOPPED] }),
			startServer,
			test: okProbe,
			prompter,
			stdout: (l) => out.push(l)
		});
		expect(prompter.line).toHaveBeenNthCalledWith(
			1,
			"« shop_postgres » est arrêté. Le démarrer ? [Y/n] "
		);
		expect(startServer).toHaveBeenCalledWith(
			STOPPED,
			"postgresql://postgres:root@localhost:5436/shop-db"
		);
		expect(out).toContain("✓ shop_postgres démarré");
		expect(loadLocalConnections()?.connections).toEqual([
			{ name: "shop-db", urlFrom: { file: envFile, key: "DATABASE_URL" } }
		]);
	});

	test("démarrage refusé : pas de démarrage, l'ajout continue", async () => {
		const startServer = vi.fn(async () => {});
		await addConnection({
			discover: discovery({ databases: [shopDb()] }),
			startServer,
			prompter: scriptedPrompter({ picks: ["shop-db"], lines: ["n", ""] }),
			stdout: (l) => out.push(l)
		});
		expect(startServer).not.toHaveBeenCalled();
		expect(loadLocalConnections()?.connections.map((c) => c.name)).toEqual([
			"shop-db"
		]);
	});

	test("démarrage en échec : la cause, puis le test dit si la base répond", async () => {
		const startServer = vi.fn(async () => {
			throw new Error(
				"Bind for 0.0.0.0:5436 failed: port is already allocated"
			);
		});
		const failing = vi.fn(async () => {
			throw new Error("connect ECONNREFUSED 127.0.0.1:5436");
		});
		await expect(
			addConnection({
				discover: discovery({ databases: [shopDb()] }),
				startServer,
				test: failing,
				prompter: scriptedPrompter({
					picks: ["shop-db"],
					lines: ["", ""],
					confirms: [false]
				}),
				stdout: (l) => out.push(l)
			})
		).rejects.toMatchObject({ kind: "cancelled" });
		expect(out).toContain(
			"✗ Démarrage de shop_postgres impossible : Bind for 0.0.0.0:5436 failed: port is already allocated"
		);
		expect(loadLocalConnections()).toBeNull();
	});

	test("serveur arrêté choisi : démarré avant de lister ses bases", async () => {
		const calls: string[] = [];
		const startServer = vi.fn(
			async (_server: DiscoveredServer, url: string) => {
				calls.push(`start ${url}`);
			}
		);
		const listDatabases = vi.fn(async (url: string) => {
			calls.push(`list ${url}`);
			return ["shop-db", "shop-archive"];
		});
		await addConnection({
			discover: discovery({ projectServers: [STOPPED] }),
			startServer,
			listDatabases,
			prompter: scriptedPrompter({
				picks: ["shop_postgres", "shop-archive"],
				lines: ["y", ""]
			}),
			stdout: (l) => out.push(l)
		});
		expect(calls).toEqual([
			"start postgres://postgres:root@localhost:5436/shop-db",
			"list postgres://postgres:root@localhost:5436/shop-db"
		]);
		expect(loadLocalConnections()?.connections).toEqual([
			{
				name: "shop-archive",
				url: "postgres://postgres:root@localhost:5436/shop-archive"
			}
		]);
	});

	test("sans moyen de démarrer : rien n'est proposé", async () => {
		const prompter = scriptedPrompter({ picks: ["shop-db"], lines: [""] });
		await addConnection({
			discover: discovery({ databases: [shopDb()] }),
			prompter,
			stdout: (l) => out.push(l)
		});
		expect(prompter.line).toHaveBeenCalledTimes(1);
		expect(prompter.line).toHaveBeenCalledWith("Nom [shop-db] : ");
	});
});

describe("discoveryChoices", () => {
	test("sections projet (bases, serveurs) et Docker, colonnes alignées, ORM, source, arrêtés, ORM sans base", () => {
		const choices = discoveryChoices(
			{
				root: "/p",
				databases: [
					database("postgresql://lab:lab@localhost:5440/apollon_prisma", {
						source: {
							kind: "compose",
							file: "/p/docker-compose.yml",
							service: "prisma",
							key: "DATABASE_URL"
						},
						orm: {
							orm: "prisma",
							dir: "/p/prisma",
							configFile: "/p/prisma/prisma/schema.prisma",
							envKey: "DATABASE_URL"
						}
					}),
					database("mongodb://localhost:27017/events", {
						source: { kind: "env-file", file: "/p/.env", key: "MONGO_URL" },
						server: {
							...LAB_SERVER,
							engine: "mongodb",
							name: "events-mongo",
							port: 27017,
							running: false
						}
					})
				],
				projectServers: [LAB_SERVER],
				servers: [{ ...LAB_SERVER, name: "db", port: 5441, running: false }],
				unresolved: [
					{
						orm: {
							orm: "doctrine",
							dir: "/p/api",
							configFile: "/p/api/composer.json",
							envKey: "DATABASE_URL"
						},
						reason: "DATABASE_URL introuvable"
					}
				]
			},
			new Map()
		);
		expect(
			choices.map((c) =>
				"separator" in c ? c.separator : [c.label, c.description ?? ""]
			)
		).toEqual([
			"── /p",
			[
				"apollon_prisma    Prisma · prisma  PostgreSQL · lab@localhost:5440",
				"DATABASE_URL · service prisma · docker-compose.yml"
			],
			[
				`events${" ".repeat(29)}MongoDB · localhost:27017 (arrêté)`,
				"MONGO_URL · .env · conteneur events-mongo"
			],
			[
				"orm-lab-postgres  PostgreSQL · localhost:5440",
				"postgres:16-alpine · compose sqlnest-orm-lab/db"
			],
			"  Doctrine · api — DATABASE_URL introuvable",
			"── Docker",
			[
				"db  PostgreSQL · localhost:5441 (arrêté)",
				"postgres:16-alpine · compose sqlnest-orm-lab/db"
			],
			"──",
			["Coller une chaîne de connexion", "URL, JDBC, ADO.NET ou libpq"],
			["Saisir à la main", ""]
		]);
	});
});
