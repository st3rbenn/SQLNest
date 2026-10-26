import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Field,
	lowerDDL,
	parse,
	type SchemaModel,
	tokenize
} from "@sqlnest/snql";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseConnectionString } from "../../services/connection-strings";
import type { OrmDetection } from "../detect";
import {
	datasourceEnvKeys,
	datasourceProvider,
	joinSchemaFiles,
	migrationName,
	prismaDatabaseUrl,
	prismaSchemaLocation,
	splitSchemaFiles
} from "./project";

const field = (name: string, type: Field["type"]): Field => ({
	name,
	type,
	nullable: false,
	source: "declared"
});

const DB: SchemaModel = {
	engine: "postgres",
	collections: [
		{
			name: "agency",
			source: "declared",
			primaryKey: ["id"],
			fields: [field("id", "int"), field("name", "string")]
		}
	],
	relations: []
};

const plan = (src: string) =>
	lowerDDL(parse(tokenize(src)) as Parameters<typeof lowerDDL>[0], DB, {
		ormProfile: "prisma"
	});

const NOW = new Date("2026-10-26T08:30:15.250Z");

describe("migrationName", () => {
	it("horodatage UTC, puis ce que fait le changement", () => {
		expect(
			migrationName(
				plan("add column nickname string nullable into agency"),
				[],
				NOW
			)
		).toBe("20261026083015_add_agency_nickname");
		expect(
			migrationName(
				plan(
					"create table agency_tag { id: int, label: string, primary key (id) }"
				),
				[],
				NOW
			)
		).toBe("20261026083015_create_agency_tag");
		expect(
			migrationName(plan("add unique index (name) into agency"), [], NOW)
		).toBe("20261026083015_unique_agency_name");
	});

	it("nom réduit à [a-z0-9_], 60 caractères au plus", () => {
		// Nom sous la limite d'identifiant de Postgres (63) ; slug de 62 caractères.
		const long = `t_${"x".repeat(53)}`;
		const name = migrationName(
			plan(`create table ${long} { id: int, primary key (id) }`),
			[],
			NOW
		);
		expect(name).toBe(`20261026083015_create_${long}`.slice(0, 15 + 60));
		expect(name).toMatch(/^\d{14}_[a-z0-9_]+$/);
	});

	it("après la dernière migration, même si l'horloge est en retard", () => {
		expect(
			migrationName(
				plan("add column nickname string nullable into agency"),
				["20261026083015_init", "20261026090000_later", "readme"],
				NOW
			)
		).toBe("20261026090001_add_agency_nickname");
	});
});

describe("datasource", () => {
	const SCHEMA = `generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider  = "sqlserver"
  url       = env("DATABASE_URL")
  directUrl = env( "DIRECT_URL" )
}
`;

	it("variables d'environnement et fournisseur du datasource, pas du generator", () => {
		expect(datasourceEnvKeys(SCHEMA)).toEqual(["DATABASE_URL", "DIRECT_URL"]);
		expect(datasourceProvider(SCHEMA)).toBe("sqlserver");
	});

	it("URL écrite en dur, ou pas de datasource", () => {
		expect(
			datasourceEnvKeys(
				'datasource db {\n  provider = "postgresql"\n  url = "postgres://h/db"\n}'
			)
		).toEqual([]);
		expect(datasourceProvider("model A {\n  id Int @id\n}")).toBeUndefined();
	});
});

describe("prismaDatabaseUrl", () => {
	it("Postgres : l'URL de la connexion telle quelle", () => {
		const c = parseConnectionString(
			"postgres://lab:lab@localhost:5440/app?schema=public"
		);
		expect(c && prismaDatabaseUrl(c)).toBe(
			"postgres://lab:lab@localhost:5440/app?schema=public"
		);
	});

	it("SQL Server : format sqlserver://, valeurs spéciales entre accolades", () => {
		const c = parseConnectionString(
			"mssql://sa:Dev%3B%7B2022%7D@localhost/Chinook?trustServerCertificate=true"
		);
		expect(c && prismaDatabaseUrl(c)).toBe(
			"sqlserver://localhost:1433;database=Chinook;user=sa;password={Dev;{2022}}};trustServerCertificate=true"
		);
	});
});

describe("schéma en plusieurs fichiers", () => {
	const files = [
		{ path: "prisma/schema/a.prisma", text: "model A {\n  id Int @id\n}\n" },
		{ path: "prisma/schema/b.prisma", text: "\nmodel B {\n  id Int @id\n}" }
	];

	it("un seul fichier : son texte, sans repère", () => {
		expect(joinSchemaFiles([files[0] as (typeof files)[0]])).toBe(
			files[0]?.text
		);
		expect(splitSchemaFiles("x", ["prisma/schema.prisma"])).toEqual(
			new Map([["prisma/schema.prisma", "x"]])
		);
	});

	it("aller-retour : chaque fichier retrouve son texte", () => {
		const joined = joinSchemaFiles(files);
		expect(joined).toContain(
			"// ⟪sqlnest-file prisma/schema/b.prisma⟫\n\nmodel B"
		);
		expect(
			splitSchemaFiles(
				joined,
				files.map((f) => f.path)
			)
		).toEqual(new Map(files.map((f) => [f.path, f.text])));
	});
});

describe("prismaSchemaLocation", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "sqlnest-prisma-project-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	const DATASOURCE =
		'datasource db {\n  provider = "postgresql"\n  url = env("DATABASE_URL")\n}\n';
	const detection = (configFile: string): OrmDetection => ({
		orm: "prisma",
		dir,
		configFile: join(dir, configFile)
	});

	it("un fichier : schéma et migrations à côté", () => {
		expect(prismaSchemaLocation(detection("prisma/schema.prisma"))).toEqual({
			arg: join(dir, "prisma/schema.prisma"),
			files: [join(dir, "prisma/schema.prisma")],
			migrations: join(dir, "prisma/migrations"),
			datasourceFile: join(dir, "prisma/schema.prisma")
		});
	});

	it("dossier prisma/schema : tous ses fichiers, triés, sous-dossiers compris", () => {
		mkdirSync(join(dir, "prisma/schema/models"), { recursive: true });
		writeFileSync(join(dir, "prisma/schema/schema.prisma"), DATASOURCE);
		writeFileSync(
			join(dir, "prisma/schema/models/user.prisma"),
			"model User {\n  id Int @id\n}\n"
		);
		writeFileSync(join(dir, "prisma/schema/README.md"), "");
		expect(
			prismaSchemaLocation(detection("prisma/schema/schema.prisma"))
		).toEqual({
			arg: join(dir, "prisma/schema"),
			files: [
				join(dir, "prisma/schema/models/user.prisma"),
				join(dir, "prisma/schema/schema.prisma")
			],
			migrations: join(dir, "prisma/schema/migrations"),
			datasourceFile: join(dir, "prisma/schema/schema.prisma")
		});
	});

	it("Prisma 7 : le schéma désigné par prisma.config.ts", () => {
		mkdirSync(join(dir, "db"), { recursive: true });
		writeFileSync(
			join(dir, "prisma.config.ts"),
			'import { defineConfig } from "prisma/config";\nexport default defineConfig({ schema: "db/app.prisma" });\n'
		);
		writeFileSync(join(dir, "db/app.prisma"), DATASOURCE);
		expect(
			prismaSchemaLocation(detection("prisma.config.ts"))?.datasourceFile
		).toBe(join(dir, "db/app.prisma"));
		rmSync(join(dir, "db/app.prisma"));
		expect(prismaSchemaLocation(detection("prisma.config.ts"))).toBeUndefined();
	});
});
