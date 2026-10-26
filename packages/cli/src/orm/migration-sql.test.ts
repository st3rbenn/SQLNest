import type { SqlQuery } from "@sqlnest/snql";
import { describe, expect, it } from "vitest";
import { migrationSql } from "./migration-sql";

const sql = (
	engine: string,
	text: string,
	params: readonly unknown[] = []
): SqlQuery => ({ engine, kind: "sql", text, params });

describe("migrationSql", () => {
	it("SNQL d'origine en tête, une instruction terminée par un point-virgule", () => {
		expect(
			migrationSql(
				sql("postgres", 'ALTER TABLE "agency" ADD COLUMN "nickname" TEXT'),
				"add column nickname string nullable into agency"
			)
		).toBe(
			'-- SQLNest : add column nickname string nullable into agency\nALTER TABLE "agency" ADD COLUMN "nickname" TEXT;\n'
		);
	});

	it("SNQL sur plusieurs lignes : chaque ligne reste en commentaire", () => {
		expect(
			migrationSql(
				sql("postgres", 'DROP TABLE "t";'),
				"\ncreate table t {\n  id: int\n}\n"
			)
		).toBe(
			'-- SQLNest : create table t {\n--     id: int\n--   }\nDROP TABLE "t";\n'
		);
	});

	it("paramètres Postgres écrits en littéraux, hors chaînes", () => {
		expect(
			migrationSql(
				sql(
					"postgres",
					'ALTER TABLE "t" ADD COLUMN "a" TEXT DEFAULT $1, ADD COLUMN "b" INT DEFAULT $2, ADD COLUMN "c" BOOLEAN DEFAULT $3, ADD COLUMN "d" TEXT DEFAULT $4 CHECK ("a" <> \'$1\')',
					["l'agence", 42, true, null]
				),
				"src"
			).split("\n")[1]
		).toBe(
			'ALTER TABLE "t" ADD COLUMN "a" TEXT DEFAULT \'l\'\'agence\', ADD COLUMN "b" INT DEFAULT 42, ADD COLUMN "c" BOOLEAN DEFAULT TRUE, ADD COLUMN "d" TEXT DEFAULT NULL CHECK ("a" <> \'$1\');'
		);
	});

	it("$10 n'est pas $1 suivi de 0", () => {
		const params = Array.from({ length: 10 }, (_, i) => i + 1);
		expect(
			migrationSql(sql("postgres", "SELECT $1, $10", params), "src").split(
				"\n"
			)[1]
		).toBe("SELECT 1, 10;");
	});

	it("paramètres SQL Server : chaînes en N'…', booléens en 1/0, bigint", () => {
		expect(
			migrationSql(
				sql(
					"mssql",
					"ALTER TABLE [t] ADD [a] NVARCHAR(MAX) DEFAULT @p1, [b] BIT DEFAULT @p2, [c] BIGINT DEFAULT @p3 -- 'it''s @p1'",
					["été", false, 9007199254740993n]
				),
				"src"
			).split("\n")[1]
		).toBe(
			"ALTER TABLE [t] ADD [a] NVARCHAR(MAX) DEFAULT N'été', [b] BIT DEFAULT 0, [c] BIGINT DEFAULT 9007199254740993 -- 'it''s @p1';"
		);
	});

	it("date en ISO, objet en JSON", () => {
		expect(
			migrationSql(
				sql("postgres", "SELECT $1, $2", [
					new Date("2026-10-26T08:00:00Z"),
					{ a: 1 }
				]),
				"src"
			).split("\n")[1]
		).toBe(`SELECT '2026-10-26T08:00:00.000Z', '{"a":1}';`);
	});

	it("paramètre sans valeur → erreur", () => {
		expect(() =>
			migrationSql(sql("postgres", "SELECT $2", ["x"]), "src")
		).toThrow("paramètre $2 sans valeur");
	});

	it("transaction Postgres : instructions à la suite, sans BEGIN (transaction implicite du fichier)", () => {
		expect(
			migrationSql(
				{
					engine: "postgres",
					kind: "transaction",
					steps: [
						{
							kind: "statement",
							query: sql("postgres", "CREATE TYPE \"e\" AS ENUM ('a')")
						},
						{ kind: "savepoint-begin", name: "s" },
						{
							kind: "statement",
							query: sql("postgres", 'ALTER TABLE "t" ADD COLUMN "c" "e";')
						}
					]
				},
				"src"
			)
		).toBe(
			'-- SQLNest : src\nCREATE TYPE "e" AS ENUM (\'a\');\nALTER TABLE "t" ADD COLUMN "c" "e";\n'
		);
	});

	it("transaction SQL Server : XACT_ABORT et transaction explicites", () => {
		expect(
			migrationSql(
				{
					engine: "mssql",
					kind: "transaction",
					steps: [
						{
							kind: "statement",
							query: sql("mssql", "ALTER TABLE [t] DROP CONSTRAINT [c]")
						},
						{
							kind: "statement",
							query: sql("mssql", "ALTER TABLE [t] DROP COLUMN [x]")
						}
					]
				},
				"src"
			)
		).toBe(
			"-- SQLNest : src\nSET XACT_ABORT ON;\nBEGIN TRAN;\nALTER TABLE [t] DROP CONSTRAINT [c];\nALTER TABLE [t] DROP COLUMN [x];\nCOMMIT;\n"
		);
	});

	it("DDL sans forme SQL (Mongo) → erreur", () => {
		expect(() =>
			migrationSql(
				{ engine: "mongodb", kind: "mongo-ddl" } as never,
				"create table t { id: int }"
			)
		).toThrow("sans forme SQL");
	});
});
