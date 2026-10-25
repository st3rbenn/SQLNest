import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectOrms } from "./detect";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "sqlnest-orm-detect-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function write(path: string, content: string): void {
	const file = join(dir, path);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, content);
}

describe("detectOrms", () => {
	it("Prisma : datasource `url = env(…)`, directUrl et shadow ignorés", () => {
		write(
			"prisma/schema.prisma",
			`datasource db {
  provider          = "postgresql"
  directUrl         = env("DIRECT_URL")
  url               = env("APP_DATABASE_URL")
  shadowDatabaseUrl = env("SHADOW_DATABASE_URL")
}
model User { id Int @id }`
		);
		expect(detectOrms(dir)).toEqual([
			{
				orm: "prisma",
				dir,
				configFile: join(dir, "prisma", "schema.prisma"),
				envKey: "APP_DATABASE_URL"
			}
		]);
	});

	it("Prisma : schéma déclaré dans package.json, URL écrite en dur", () => {
		write(
			"package.json",
			JSON.stringify({ prisma: { schema: "db/app.prisma" } })
		);
		write(
			"db/app.prisma",
			'datasource db {\n  provider = "sqlserver"\n  url = "sqlserver://localhost:1433;database=x"\n}'
		);
		expect(detectOrms(dir)[0]).toMatchObject({
			orm: "prisma",
			configFile: join(dir, "db", "app.prisma"),
			url: "sqlserver://localhost:1433;database=x"
		});
	});

	it("Prisma 7 : l'URL passe dans prisma.config.ts", () => {
		write(
			"prisma/schema/base.prisma",
			'datasource db {\n  provider = "postgresql"\n}'
		);
		write(
			"prisma.config.ts",
			'export default defineConfig({ datasource: { url: env("DATABASE_URL") } });'
		);
		expect(detectOrms(dir)).toEqual([
			{
				orm: "prisma",
				dir,
				configFile: join(dir, "prisma.config.ts"),
				envKey: "DATABASE_URL"
			}
		]);
	});

	it("Doctrine : doctrine.yaml `%env(resolve:…)%`, sinon DATABASE_URL", () => {
		write(
			"composer.json",
			JSON.stringify({ require: { "doctrine/orm": "^3.3" } })
		);
		expect(detectOrms(dir)).toEqual([
			{
				orm: "doctrine",
				dir,
				configFile: join(dir, "composer.json"),
				envKey: "DATABASE_URL"
			}
		]);
		write(
			"config/packages/doctrine.yaml",
			"doctrine:\n  dbal:\n    url: '%env(resolve:MAIN_DB_URL)%'\n"
		);
		expect(detectOrms(dir)[0]).toMatchObject({
			configFile: join(dir, "config", "packages", "doctrine.yaml"),
			envKey: "MAIN_DB_URL"
		});
	});

	it("Sequelize : config de .sequelizerc, `use_env_variable`", () => {
		write(
			"package.json",
			JSON.stringify({ dependencies: { sequelize: "^6" } })
		);
		write(
			".sequelizerc",
			'const path = require("node:path");\nmodule.exports = { config: path.resolve("db", "config.js") };'
		);
		write(
			"db/config.js",
			'module.exports = { development: { use_env_variable: "DATABASE_URL", dialect: "postgres" } };'
		);
		expect(detectOrms(dir)).toEqual([
			{
				orm: "sequelize",
				dir,
				configFile: join(dir, "db", "config.js"),
				envKey: "DATABASE_URL"
			}
		]);
	});

	it("Sequelize : config.json écrite en dur → URL", () => {
		write(
			"package.json",
			JSON.stringify({ devDependencies: { sequelize: "^6" } })
		);
		write(
			"config/config.json",
			JSON.stringify({
				development: {
					username: "app",
					password: "p@ss",
					database: "shop",
					host: "127.0.0.1",
					port: 5433,
					dialect: "postgres"
				}
			})
		);
		expect(detectOrms(dir)[0]).toMatchObject({
			orm: "sequelize",
			url: "postgres://app:p%40ss@127.0.0.1:5433/shop"
		});
	});

	it("SeaORM : dépendance sea-orm (ligne ou table) → DATABASE_URL", () => {
		write("Cargo.toml", '[dependencies]\nsea-orm = { version = "1" }\n');
		expect(detectOrms(dir)).toEqual([
			{
				orm: "seaorm",
				dir,
				configFile: join(dir, "Cargo.toml"),
				envKey: "DATABASE_URL"
			}
		]);
		write("Cargo.toml", '[dependencies.sea-orm]\nversion = "1"\n');
		expect(detectOrms(dir)[0]?.orm).toBe("seaorm");
	});

	it("dossier sans ORM → rien", () => {
		write("package.json", JSON.stringify({ dependencies: { express: "^5" } }));
		write("Cargo.toml", '[dependencies]\nserde = "1"\n');
		expect(detectOrms(dir)).toEqual([]);
	});
});
