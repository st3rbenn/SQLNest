import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { OrmDetection } from "../../orm/detect";
import type { TunnelEntry } from "../../services/config";
import { parseConnectionString } from "../../services/connection-strings";
import type {
	DiscoveredDatabase,
	DiscoveredServer,
	Discovery
} from "../../services/discovery";
import { saveLocalConnections } from "../../services/local-connections";
import type { Prompter, SelectChoice, SelectEntry } from "../../ui/prompts";
import { type ChooseConnectionOptions, chooseConnection } from "./choose";

let home: string;
let root: string;
let out: string[];

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "sqlnest-choose-"));
	root = join(home, "work", "shop");
	mkdirSync(join(root, ".git"), { recursive: true });
	mkdirSync(join(root, "backend", "src"), { recursive: true });
	process.env.SQLNEST_CONFIG_DIR = join(home, "config");
	out = [];
});

afterEach(() => {
	delete process.env.SQLNEST_CONFIG_DIR;
	rmSync(home, { recursive: true, force: true });
});

const ADD_LABEL = "Ajouter une connexion…";

function prompter(script: { lines?: string[]; pick?: string }): Prompter & {
	menus: SelectEntry<unknown>[][];
} {
	const lines = [...(script.lines ?? [])];
	const menus: SelectEntry<unknown>[][] = [];
	return {
		menus,
		line: vi.fn(async () => {
			const next = lines.shift();
			if (next === undefined) throw new Error("line inattendue");
			return next;
		}),
		password: vi.fn(async () => ""),
		confirm: vi.fn(async () => false),
		select: vi.fn(async <T>(opts: { choices: readonly SelectEntry<T>[] }) => {
			menus.push([...opts.choices] as SelectEntry<unknown>[]);
			const choice = opts.choices.find(
				(c): c is SelectChoice<T> =>
					"value" in c &&
					c.disabled === undefined &&
					c.label.startsWith(script.pick ?? "")
			);
			if (choice === undefined) throw new Error("pas de choix");
			return choice.value;
		}) as Prompter["select"]
	};
}

const prismaOrm = (): OrmDetection => ({
	orm: "prisma",
	dir: join(root, "backend"),
	configFile: join(root, "backend", "prisma", "schema.prisma"),
	envKey: "DATABASE_URL"
});

function database(url: string, orm?: OrmDetection): DiscoveredDatabase {
	const connection = parseConnectionString(url);
	if (connection === undefined) throw new Error(url);
	return {
		connection,
		source: {
			kind: "env-file",
			file: join(root, "backend", ".env"),
			key: "DATABASE_URL"
		},
		...(orm !== undefined ? { orm } : {})
	};
}

function discovery(partial: Partial<Discovery> = {}): () => Promise<Discovery> {
	return vi.fn(async () => ({
		root,
		databases: [],
		projectServers: [],
		servers: [],
		unresolved: [],
		...partial
	}));
}

function options(
	partial: Partial<ChooseConnectionOptions>
): ChooseConnectionOptions {
	return {
		cwd: root,
		home,
		interactive: true,
		tunnels: [],
		discover: discovery(),
		addConnection: vi.fn(async () => "nouvelle"),
		link: vi.fn(async () => {}),
		prompter: prompter({}),
		stdout: (l) => out.push(l),
		stderr: (l) => out.push(l),
		...partial
	};
}

const SHOP_URL = "postgresql://postgres:root@localhost:5436/shop-db";

describe("chooseConnection — projet relié (ADR-038 S6)", () => {
	test("dans le projet relié : sa connexion, sans menu ni découverte", async () => {
		saveLocalConnections({
			version: 2,
			connections: [
				{ name: "other", url: "postgres://u@localhost:5433/chinook" },
				{
					name: "shop",
					url: SHOP_URL,
					project: { path: join(root, "backend"), orm: "prisma", apply: true }
				}
			]
		});
		const discover = discovery();
		const name = await chooseConnection(
			options({
				cwd: join(root, "backend", "src"),
				interactive: false,
				discover
			})
		);
		expect(name).toBe("shop");
		expect(discover).not.toHaveBeenCalled();
		expect(out).toEqual(["Connexion : shop — projet relié (Prisma · backend)"]);
	});

	test("racine d'un dépôt dont une seule connexion est reliée : celle-ci", async () => {
		saveLocalConnections({
			version: 2,
			connections: [
				{ name: "other", url: "postgres://u@localhost:5433/chinook" },
				{
					name: "shop",
					url: SHOP_URL,
					project: { path: join(root, "backend"), orm: "prisma", apply: true }
				}
			]
		});
		expect(await chooseConnection(options({ interactive: false }))).toBe(
			"shop"
		);
	});

	test("projet non relié, base visée par une connexion : liaison proposée (Entrée = oui)", async () => {
		saveLocalConnections({
			version: 1,
			connections: [
				{ name: "shop", url: SHOP_URL },
				{ name: "other", url: "postgres://u@localhost:5433/chinook" }
			]
		});
		const link = vi.fn(async () => {});
		const p = prompter({ lines: [""] });
		const name = await chooseConnection(
			options({
				discover: discovery({ databases: [database(SHOP_URL, prismaOrm())] }),
				link,
				prompter: p
			})
		);
		expect(name).toBe("shop");
		expect(p.line).toHaveBeenCalledWith(
			"Le projet Prisma (backend) lit postgres@localhost:5436/shop-db, celle de « shop ». Relier le projet ? [Y/n] "
		);
		expect(link).toHaveBeenCalledWith("shop", prismaOrm());
	});

	test("projet non relié, aucune connexion vers sa base : création puis liaison", async () => {
		const shopDb = database(SHOP_URL, prismaOrm());
		const addConnection = vi.fn(async () => "shop-db");
		const link = vi.fn(async () => {});
		const name = await chooseConnection(
			options({
				discover: discovery({ databases: [shopDb] }),
				addConnection,
				link,
				prompter: prompter({ lines: [""] })
			})
		);
		expect(name).toBe("shop-db");
		expect(addConnection).toHaveBeenCalledWith(shopDb);
		expect(link).toHaveBeenCalledWith("shop-db", prismaOrm());
	});
});

describe("chooseConnection — menu", () => {
	const STOPPED: DiscoveredServer = {
		engine: "postgres",
		name: "shop_postgres",
		image: "postgres:16-alpine",
		host: "localhost",
		port: 5999,
		user: "postgres",
		password: "root",
		passwordless: false,
		maintenanceDatabase: "shop-db",
		defaultDatabase: "shop-db",
		params: {},
		running: false,
		container: "shop_postgres"
	};
	const tunnels: TunnelEntry[] = [
		{
			id: "t1",
			name: "mac",
			connection_id: "c1",
			session_token: "tn_x",
			expires_at: new Date(
				Date.now() + 20 * 24 * 3600 * 1000 + 60_000
			).toISOString(),
			connection_name: "chinook"
		}
	];

	test("sections projet / autres, base arrêtée, état du tunnel, .env illisible grisé, ajout", async () => {
		saveLocalConnections({
			version: 2,
			connections: [
				{ name: "chinook", url: "postgres://sqlnest:x@localhost:5433/chinook" },
				{
					name: "shop",
					url: "postgresql://postgres:root@localhost:5999/shop-db"
				},
				{
					name: "broken",
					urlFrom: { file: join(home, "gone.env"), key: "DATABASE_URL" }
				}
			]
		});
		const p = prompter({ lines: ["n"], pick: ADD_LABEL });
		const addConnection = vi.fn(async () => "nouvelle");
		const name = await chooseConnection(
			options({
				tunnels,
				discover: discovery({
					databases: [
						database(
							"postgresql://postgres:root@localhost:5999/shop-db",
							prismaOrm()
						)
					],
					projectServers: [STOPPED]
				}),
				addConnection,
				prompter: p
			})
		);
		expect(name).toBe("nouvelle");
		expect(addConnection).toHaveBeenCalledWith();
		const menu = (p.menus[0] ?? []).map((c) =>
			"separator" in c ? c.separator : [c.label, c.disabled ?? ""]
		);
		const shopCell = "PostgreSQL · localhost:5999/shop-db (arrêté)";
		const chinookCell = "PostgreSQL · localhost:5433/chinook";
		expect(menu).toEqual([
			`── ${root}`,
			[`shop     ${shopCell}`, ""],
			"── Autres connexions",
			[
				`chinook  ${chinookCell.padEnd(shopCell.length)}  tunnel valide 20j`,
				""
			],
			["broken", expect.stringContaining("fichier introuvable")],
			"──",
			[ADD_LABEL, ""]
		]);
	});

	test("aucune connexion : la découverte d'add-connection", async () => {
		const addConnection = vi.fn(async () => "apollon-db");
		expect(await chooseConnection(options({ addConnection }))).toBe(
			"apollon-db"
		);
		expect(out).toContain("Aucune connexion enregistrée — choisis une base :");
	});

	test("sans terminal : 0 → null, plusieurs → liste numérotée", async () => {
		expect(await chooseConnection(options({ interactive: false }))).toBeNull();
		saveLocalConnections({
			version: 1,
			connections: [
				{ name: "a", url: "postgres://u@localhost/a" },
				{ name: "b", url: "postgres://u@localhost/b" }
			]
		});
		const p = prompter({ lines: ["2"] });
		expect(
			await chooseConnection(
				options({ interactive: false, prompter: p, cwd: home })
			)
		).toBe("b");
		expect(out).toContain("  2) b");
	});

	test("--connection inconnu : erreur qui liste les connues", async () => {
		saveLocalConnections({
			version: 1,
			connections: [{ name: "a", url: "postgres://u@localhost/a" }]
		});
		await expect(chooseConnection(options({ explicit: "zz" }))).rejects.toThrow(
			/aucune connexion « zz ».*Connues : a/
		);
	});
});
