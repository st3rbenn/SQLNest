import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { OrmDetection } from "../../orm/detect";
import { parseConnectionString } from "../../services/connection-strings";
import type { DiscoveredDatabase, Discovery } from "../../services/discovery";
import {
	loadLocalConnections,
	saveLocalConnections
} from "../../services/local-connections";
import type { Prompter, SelectChoice, SelectEntry } from "../../ui/prompts";
import { type LinkProjectOptions, linkProject } from ".";

let dir: string;
let out: string[];

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "sqlnest-link-"));
	process.env.SQLNEST_CONFIG_DIR = join(dir, "config");
	out = [];
});

afterEach(() => {
	delete process.env.SQLNEST_CONFIG_DIR;
	rmSync(dir, { recursive: true, force: true });
});

function prompter(script: {
	lines?: string[];
	confirms?: boolean[];
	pick?: string;
}): Prompter {
	const lines = [...(script.lines ?? [])];
	const confirms = [...(script.confirms ?? [])];
	return {
		line: vi.fn(async () => {
			const next = lines.shift();
			if (next === undefined) throw new Error("line inattendue");
			return next;
		}),
		password: vi.fn(async () => ""),
		confirm: vi.fn(async () => {
			const next = confirms.shift();
			if (next === undefined) throw new Error("confirm inattendu");
			return next;
		}),
		select: vi.fn(async <T>(opts: { choices: readonly SelectEntry<T>[] }) => {
			const choice = opts.choices.find(
				(c): c is SelectChoice<T> =>
					"value" in c && c.label.includes(script.pick ?? "")
			);
			if (choice === undefined) throw new Error("pas de choix");
			return choice.value;
		}) as Prompter["select"]
	};
}

/** Projet Prisma réel sur disque (la détection explicite le lit). */
function prismaProject(name: string): OrmDetection {
	const project = join(dir, name);
	mkdirSync(join(project, "prisma", "migrations"), { recursive: true });
	const schema = join(project, "prisma", "schema.prisma");
	writeFileSync(
		schema,
		'datasource db {\n  provider = "postgresql"\n  url = env("DATABASE_URL")\n}'
	);
	return {
		orm: "prisma",
		dir: project,
		configFile: schema,
		envKey: "DATABASE_URL"
	};
}

function database(url: string, orm?: OrmDetection): DiscoveredDatabase {
	const connection = parseConnectionString(url);
	if (connection === undefined) throw new Error(url);
	return {
		connection,
		source: { kind: "env-file", file: join(dir, ".env"), key: "DATABASE_URL" },
		...(orm !== undefined ? { orm } : {})
	};
}

function discovery(partial: Partial<Discovery>): () => Promise<Discovery> {
	return async () => ({
		root: dir,
		databases: [],
		projectServers: [],
		servers: [],
		unresolved: [],
		...partial
	});
}

const probe = (tables: string[]) =>
	vi.fn(async () => ({
		latencyMs: 1,
		collectionCount: tables.length,
		collectionNames: tables
	}));

function options(partial: Partial<LinkProjectOptions>): LinkProjectOptions {
	return {
		apply: true,
		cwd: dir,
		discover: discovery({}),
		probe: probe(["_prisma_migrations"]),
		createConnection: vi.fn(async () => {
			throw new Error("création inattendue");
		}),
		interactive: true,
		prompter: prompter({}),
		stdout: (l) => out.push(l),
		...partial
	};
}

const LAB_URL = "postgres://lab:lab@localhost:5440/apollon_prisma";

describe("link-project dans un projet", () => {
	test("connexion qui vise la base du projet : retrouvée, historique vérifié, projet relié", async () => {
		const orm = prismaProject("prisma");
		saveLocalConnections({
			version: 1,
			connections: [{ name: "lab", url: LAB_URL }]
		});
		const res = await linkProject(
			options({ discover: discovery({ databases: [database(LAB_URL, orm)] }) })
		);
		expect(res).toEqual({
			name: "lab",
			project: { path: orm.dir, orm: "prisma", apply: true }
		});
		expect(loadLocalConnections()?.connections[0]?.project).toEqual({
			path: orm.dir,
			orm: "prisma",
			apply: true
		});
		expect(out).toContain("✓ _prisma_migrations présente dans la base");
		expect(out.at(-1)).toMatch(/^✓ « lab » relié à .*prisma \(Prisma\)$/);
	});

	test("aucune connexion ne vise la base : créée avec accord, puis reliée", async () => {
		const orm = prismaProject("prisma");
		const createConnection = vi.fn(async () => {
			saveLocalConnections({
				version: 1,
				connections: [{ name: "apollon_prisma", url: LAB_URL }]
			});
			return "apollon_prisma";
		});
		const res = await linkProject(
			options({
				discover: discovery({ databases: [database(LAB_URL, orm)] }),
				createConnection,
				prompter: prompter({ lines: [""] })
			})
		);
		expect(createConnection).toHaveBeenCalledOnce();
		expect(res.name).toBe("apollon_prisma");
	});

	test("sans terminal et sans connexion : échec qui indique add-connection", async () => {
		const orm = prismaProject("prisma");
		await expect(
			linkProject(
				options({
					discover: discovery({ databases: [database(LAB_URL, orm)] }),
					interactive: false
				})
			)
		).rejects.toThrow(
			"Aucune connexion ne vise lab@localhost:5440/apollon_prisma — crée-la : sqlnest add-connection"
		);
	});

	test("base gérée par un autre ORM : refus, rien n'est relié", async () => {
		const orm = prismaProject("prisma");
		saveLocalConnections({
			version: 1,
			connections: [{ name: "lab", url: LAB_URL }]
		});
		await expect(
			linkProject(
				options({
					discover: discovery({ databases: [database(LAB_URL, orm)] }),
					probe: probe(["SequelizeMeta", "users"])
				})
			)
		).rejects.toMatchObject({
			kind: "mismatch",
			message: "La base est gérée par Sequelize (SequelizeMeta), pas par Prisma"
		});
		expect(loadLocalConnections()?.connections[0]?.project).toBeUndefined();
	});

	test("plusieurs projets : celui du dossier courant ; sans terminal hors d'eux, la liste", async () => {
		const prisma = prismaProject("prisma");
		const seaorm: OrmDetection = {
			orm: "seaorm",
			dir: join(dir, "seaorm"),
			configFile: join(dir, "seaorm", "Cargo.toml"),
			envKey: "DATABASE_URL"
		};
		saveLocalConnections({
			version: 1,
			connections: [
				{ name: "lab", url: LAB_URL },
				{ name: "sea", url: "postgres://lab:lab@localhost:5440/apollon_seaorm" }
			]
		});
		const found = discovery({
			databases: [
				database(LAB_URL, prisma),
				database("postgres://lab:lab@localhost:5440/apollon_seaorm", seaorm)
			]
		});
		const res = await linkProject(
			options({
				discover: found,
				cwd: join(seaorm.dir, "src"),
				probe: probe(["seaql_migrations"])
			})
		);
		expect(res.name).toBe("sea");
		await expect(
			linkProject(options({ discover: found, interactive: false }))
		).rejects.toThrow("Plusieurs projets (Prisma · prisma, SeaORM · seaorm)");
	});

	test("--no-apply : enregistré, annoncé", async () => {
		const orm = prismaProject("prisma");
		saveLocalConnections({
			version: 1,
			connections: [{ name: "lab", url: LAB_URL }]
		});
		await linkProject(
			options({
				apply: false,
				discover: discovery({ databases: [database(LAB_URL, orm)] })
			})
		);
		expect(loadLocalConnections()?.connections[0]?.project?.apply).toBe(false);
		expect(out.at(-1)).toMatch(/migrations écrites sans toucher la base\)$/);
	});

	test("base injoignable : relier sans vérifier, avec accord", async () => {
		const orm = prismaProject("prisma");
		saveLocalConnections({
			version: 1,
			connections: [{ name: "lab", url: LAB_URL }]
		});
		await linkProject(
			options({
				discover: discovery({ databases: [database(LAB_URL, orm)] }),
				probe: vi.fn(async () => {
					throw new Error("connect ECONNREFUSED 127.0.0.1:5440");
				}),
				prompter: prompter({ confirms: [true] })
			})
		);
		expect(out).toContain(
			"✗ Base injoignable : connect ECONNREFUSED 127.0.0.1:5440"
		);
		expect(loadLocalConnections()?.connections[0]?.project?.orm).toBe("prisma");
	});

	test("aucun projet ORM ici → not-found", async () => {
		await expect(linkProject(options({}))).rejects.toMatchObject({
			kind: "not-found"
		});
	});
});

describe("link-project <connexion> <dossier>", () => {
	test("connexion inconnue : les connues sont citées", async () => {
		saveLocalConnections({
			version: 1,
			connections: [{ name: "lab", url: LAB_URL }]
		});
		await expect(
			linkProject(options({ connection: "ghost", dir: "." }))
		).rejects.toThrow("Aucune connexion « ghost » (connues : lab).");
	});

	test("le projet lit une autre base : avertissement, refus sans accord", async () => {
		const orm = prismaProject("prisma");
		saveLocalConnections({
			version: 1,
			connections: [
				{ name: "other", url: "postgres://u:p@localhost:5433/chinook" }
			]
		});
		await expect(
			linkProject(
				options({
					connection: "other",
					dir: "prisma",
					discover: discovery({ databases: [database(LAB_URL, orm)] }),
					prompter: prompter({ confirms: [false] })
				})
			)
		).rejects.toMatchObject({ kind: "cancelled" });
		expect(out).toContain(
			"⚠ Le projet lit lab@localhost:5440/apollon_prisma ; « other » vise u@localhost:5433/chinook"
		);
		await expect(
			linkProject(
				options({
					connection: "other",
					dir: "prisma",
					discover: discovery({ databases: [database(LAB_URL, orm)] }),
					interactive: false
				})
			)
		).rejects.toMatchObject({ kind: "mismatch" });
	});

	test("même base : relié ; dossier sans ORM : refusé", async () => {
		const orm = prismaProject("prisma");
		saveLocalConnections({
			version: 1,
			connections: [{ name: "lab", url: LAB_URL }]
		});
		const res = await linkProject(
			options({
				connection: "lab",
				dir: "prisma",
				discover: discovery({ databases: [database(LAB_URL, orm)] })
			})
		);
		expect(res.project.path).toBe(orm.dir);
		mkdirSync(join(dir, "empty"));
		await expect(
			linkProject(options({ connection: "lab", dir: "empty" }))
		).rejects.toThrow(
			/Aucun projet Prisma, Doctrine, Sequelize ou SeaORM dans/
		);
	});
});
