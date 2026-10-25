import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DockerRunner } from "./docker";
import { discoverProject, projectDirs } from "./project";

let home: string;
let root: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "sqlnest-discovery-"));
	root = join(home, "work", "shop");
	mkdirSync(join(root, ".git"), { recursive: true });
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

function write(path: string, content: string): void {
	const file = join(root, path);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, content);
}

const noDocker: DockerRunner = async () => undefined;

/** `docker compose config` rend `config` pour tout dossier. */
function composeRunner(config: unknown): DockerRunner {
	return vi.fn(async (args: readonly string[]) =>
		args[0] === "compose" ? JSON.stringify(config) : undefined
	);
}

describe("projectDirs", () => {
	it("du dossier courant à la racine git, jamais au-delà", () => {
		mkdirSync(join(root, "apps", "api"), { recursive: true });
		expect(projectDirs(join(root, "apps", "api"), home)).toEqual({
			dirs: [join(root, "apps", "api"), join(root, "apps"), root],
			root
		});
	});

	it("sans git : jusqu'au premier dossier qui porte un manifeste", () => {
		rmSync(join(root, ".git"), { recursive: true });
		write("package.json", "{}");
		mkdirSync(join(root, "src"));
		expect(projectDirs(join(root, "src"), home)).toEqual({
			dirs: [join(root, "src"), root],
			root
		});
	});

	it("le dossier personnel n'est ni lu ni dépassé", () => {
		expect(projectDirs(home, home)).toBeUndefined();
		rmSync(join(root, ".git"), { recursive: true });
		const bare = join(home, "notes");
		mkdirSync(bare);
		expect(projectDirs(bare, home)).toEqual({ dirs: [bare], root: bare });
	});
});

describe("discoverProject — .env et ORM", () => {
	it("variable d'un .env : référence au .env, ORM qui la lit, shadow ignorée", async () => {
		write("package.json", JSON.stringify({ devDependencies: { prisma: "6" } }));
		write(
			"prisma/schema.prisma",
			'datasource db {\n  provider = "postgresql"\n  url = env("DATABASE_URL")\n}'
		);
		write(
			".env",
			[
				'DATABASE_URL="postgresql://app:s3cret@localhost:5440/shop?schema=public"',
				"SHADOW_DATABASE_URL=postgresql://app:s3cret@localhost:5440/shop_shadow",
				"MONGO_URL=mongodb://localhost:27017/events",
				"PORT=3000"
			].join("\n")
		);
		const found = await discoverProject(root, home, {}, noDocker);
		expect(found.root).toBe(root);
		expect(found.unresolved).toEqual([]);
		expect(found.databases).toEqual([
			{
				connection: expect.objectContaining({
					engine: "postgres",
					host: "localhost",
					port: 5440,
					database: "shop"
				}),
				source: {
					kind: "env-file",
					file: join(root, ".env"),
					key: "DATABASE_URL"
				},
				urlFrom: { file: join(root, ".env"), key: "DATABASE_URL" },
				orm: expect.objectContaining({ orm: "prisma", dir: root })
			},
			{
				connection: expect.objectContaining({
					engine: "mongodb",
					database: "events"
				}),
				source: {
					kind: "env-file",
					file: join(root, ".env"),
					key: "MONGO_URL"
				},
				urlFrom: { file: join(root, ".env"), key: "MONGO_URL" }
			}
		]);
	});

	it("même base dans deux fichiers : une entrée ; le .env le plus proche de l'ORM le désigne", async () => {
		write(".env", "DATABASE_URL=postgres://a:b@localhost:5432/core");
		write(
			"apps/api/.env.local",
			"DATABASE_URL=postgres://a:b@127.0.0.1:5432/CORE"
		);
		write("apps/api/.env", "DATABASE_URL=postgres://a:b@localhost:5432/api");
		write("apps/api/Cargo.toml", '[dependencies]\nsea-orm = "1"\n');
		const found = await discoverProject(
			join(root, "apps", "api"),
			home,
			{},
			noDocker
		);
		expect(
			found.databases.map((d) => [d.connection.database, d.source, d.orm?.orm])
		).toEqual([
			[
				"api",
				{
					kind: "env-file",
					file: join(root, "apps", "api", ".env"),
					key: "DATABASE_URL"
				},
				"seaorm"
			],
			[
				"CORE",
				{
					kind: "env-file",
					file: join(root, "apps", "api", ".env.local"),
					key: "DATABASE_URL"
				},
				undefined
			]
		]);
	});

	it("style Laravel DB_* : copie de l'URL ; ORM sans base : signalé", async () => {
		write(
			".env",
			"DB_CONNECTION=pgsql\nDB_HOST=127.0.0.1\nDB_PORT=5433\nDB_DATABASE=crm\nDB_USERNAME=crm\nDB_PASSWORD=x"
		);
		write(
			"composer.json",
			JSON.stringify({ require: { "doctrine/orm": "3" } })
		);
		const found = await discoverProject(root, home, {}, noDocker);
		expect(found.databases).toEqual([
			{
				connection: expect.objectContaining({
					url: "postgres://crm:x@127.0.0.1:5433/crm",
					database: "crm"
				}),
				source: { kind: "env-file", file: join(root, ".env"), key: "DB_*" }
			}
		]);
		expect(found.unresolved).toEqual([
			{
				orm: expect.objectContaining({ orm: "doctrine" }),
				reason: "DATABASE_URL introuvable"
			}
		]);
	});

	it("variable présente mais moteur non servi : pas signalée introuvable", async () => {
		write(
			"composer.json",
			JSON.stringify({ require: { "doctrine/orm": "3" } })
		);
		write(".env", "DATABASE_URL=mysql://u:p@localhost:3306/app");
		const found = await discoverProject(root, home, {}, noDocker);
		expect(found.databases).toEqual([]);
		expect(found.unresolved).toEqual([]);
	});
});

describe("discoverProject — docker compose", () => {
	const config = (ctx: string) => ({
		name: "shop",
		services: {
			db: {
				image: "postgres:16-alpine",
				container_name: "shop-postgres",
				environment: {
					POSTGRES_USER: "lab",
					POSTGRES_PASSWORD: "lab",
					POSTGRES_DB: "lab"
				},
				ports: [
					{ mode: "ingress", target: 5432, published: "5440", protocol: "tcp" }
				]
			},
			cache: { image: "redis:7", ports: [{ target: 6379, published: "6379" }] },
			web: {
				build: { context: ctx },
				environment: {
					DATABASE_URL: "postgres://lab:lab@db:5432/shop_web",
					SHADOW_DATABASE_URL: "postgres://lab:lab@db:5432/shop_shadow",
					NODE_ENV: null
				},
				volumes: [{ type: "bind", source: ctx, target: "/app" }]
			}
		}
	});

	it("URL d'un service vers `db:5432` → port publié ; ORM du contexte de build ; serveur compose", async () => {
		write("docker-compose.yml", "services: {}\n");
		write(
			"web/package.json",
			JSON.stringify({ dependencies: { sequelize: "6" } })
		);
		write(
			"web/config/config.json",
			JSON.stringify({ development: { use_env_variable: "DATABASE_URL" } })
		);
		const docker = composeRunner(config(join(root, "web")));
		const found = await discoverProject(root, home, {}, docker);
		expect(docker).toHaveBeenCalledWith(
			["compose", "config", "--format", "json"],
			root
		);
		expect(found.databases).toEqual([
			{
				connection: expect.objectContaining({
					url: "postgres://lab:lab@localhost:5440/shop_web",
					host: "localhost",
					port: 5440
				}),
				source: {
					kind: "compose",
					file: join(root, "docker-compose.yml"),
					service: "web",
					key: "DATABASE_URL"
				},
				orm: expect.objectContaining({
					orm: "sequelize",
					dir: join(root, "web")
				})
			}
		]);
		expect(found.servers).toEqual([
			expect.objectContaining({
				engine: "postgres",
				name: "shop-postgres",
				host: "localhost",
				port: 5440,
				user: "lab",
				password: "lab",
				defaultDatabase: "lab",
				running: false,
				compose: { project: "shop", service: "db" }
			})
		]);
	});

	it(".env qui vise un service compose : réécrit, gardé en copie", async () => {
		write("compose.yaml", "services: {}\n");
		write(
			".env",
			"DATABASE_URL=postgres://lab:lab@db:5432/shop_web\nOTHER=postgres://u@cache:5432/x"
		);
		const found = await discoverProject(
			root,
			home,
			{},
			composeRunner(config(join(root, "web")))
		);
		const fromEnv = found.databases.filter((d) => d.source.kind === "env-file");
		expect(fromEnv).toEqual([
			{
				connection: expect.objectContaining({
					url: "postgres://lab:lab@localhost:5440/shop_web"
				}),
				source: {
					kind: "env-file",
					file: join(root, ".env"),
					key: "DATABASE_URL"
				}
			}
		]);
		// Une seule entrée pour la base : celle du .env passe avant celle du service.
		expect(found.databases).toHaveLength(1);
	});

	it("sans Docker : les .env restent lus", async () => {
		write("docker-compose.yml", "services: {}\n");
		write(".env", "DATABASE_URL=postgres://u:p@localhost:5432/app");
		const found = await discoverProject(root, home, {}, noDocker);
		expect(found.databases).toHaveLength(1);
		expect(found.servers).toEqual([]);
	});
});
