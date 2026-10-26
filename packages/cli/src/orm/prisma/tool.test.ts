import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findPrismaBinary, runTool, toolMessage, toolScript } from "./tool";

const PROJECT = "/Users/dev/apps/api";

describe("toolMessage", () => {
	it("validation : ni couleurs, ni lignes de contexte, ni extrait du modèle ; chemins relatifs", () => {
		const stderr = [
			"Prisma schema loaded from prisma/schema.prisma",
			"\x1b[1;91mError\x1b[0m: Prisma schema validation - (validate wasm)",
			"Error code: P1012",
			'error: Error validating model "Bad-Name": The name is invalid.',
			`  -->  ${PROJECT}/prisma/schema.prisma:12`,
			"   | ",
			"11 | ",
			"12 | model Bad-Name {",
			"   | ",
			"",
			"Validation Error Count: 1",
			"[Context: validate]",
			"",
			"Prisma CLI Version : 6.19.2"
		].join("\n");
		expect(toolMessage({ code: 1, stdout: "", stderr }, PROJECT)).toBe(
			[
				"Error: Prisma schema validation - (validate wasm)",
				"Error code: P1012",
				'error: Error validating model "Bad-Name": The name is invalid.',
				"  -->  prisma/schema.prisma:12",
				"Validation Error Count: 1"
			].join("\n")
		);
	});

	it("migration en échec : l'erreur de la base, sans la structure DbError", () => {
		const stdout = [
			'Datasource "db": PostgreSQL database "app", schema "public" at "localhost:5440"',
			"",
			"Applying migration `20261026083015_unique_agency_name`"
		].join("\n");
		const stderr = [
			"Error: P3018",
			"",
			"Migration name: 20261026083015_unique_agency_name",
			"",
			"Database error code: 23505",
			"",
			"Database error:",
			'ERROR: could not create unique index "agency_name_key"',
			"DETAIL: Key (name)=(doublon) is duplicated.",
			"",
			'DbError { severity: "ERROR", code: SqlState(E23505) }'
		].join("\n");
		expect(toolMessage({ code: 1, stdout, stderr }, `${PROJECT}/`)).toBe(
			[
				"Error: P3018",
				"Migration name: 20261026083015_unique_agency_name",
				"Database error code: 23505",
				"Database error:",
				'ERROR: could not create unique index "agency_name_key"',
				"DETAIL: Key (name)=(doublon) is duplicated.",
				"Applying migration `20261026083015_unique_agency_name`"
			].join("\n")
		);
	});
});

describe("toolScript", () => {
	it("le SQL du diff, lignes vides comprises, sans les lignes de contexte", () => {
		const stdout = [
			"Prisma schema loaded from prisma/schema.prisma",
			"-- AlterTable",
			'ALTER TABLE "agency" ALTER COLUMN "motto" SET DEFAULT \'été\';',
			"",
			"-- CreateIndex",
			'CREATE INDEX "agency_name_idx" ON "agency"("name");',
			""
		].join("\n");
		expect(toolScript({ code: 2, stdout, stderr: "" })).toBe(
			[
				"-- AlterTable",
				'ALTER TABLE "agency" ALTER COLUMN "motto" SET DEFAULT \'été\';',
				"",
				"-- CreateIndex",
				'CREATE INDEX "agency_name_idx" ON "agency"("name");'
			].join("\n")
		);
	});
});

describe("findPrismaBinary", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "sqlnest-prisma-bin-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("binaire du projet, sinon d'un dossier parent (monorepo), sinon rien", () => {
		const api = join(dir, "apps", "api");
		mkdirSync(api, { recursive: true });
		expect(findPrismaBinary(api)).toBeUndefined();
		const bin = join(dir, "node_modules", ".bin");
		mkdirSync(bin, { recursive: true });
		writeFileSync(join(bin, "prisma"), "");
		expect(findPrismaBinary(api)).toBe(join(bin, "prisma"));
		mkdirSync(join(api, "node_modules", ".bin"), { recursive: true });
		writeFileSync(join(api, "node_modules", ".bin", "prisma"), "");
		expect(findPrismaBinary(api)).toBe(
			join(api, "node_modules", ".bin", "prisma")
		);
	});
});

describe("runTool", () => {
	const node = process.execPath;

	it("code de sortie, sorties séparées, environnement transmis", async () => {
		expect(
			await runTool(
				node,
				[
					"-e",
					"process.stdout.write(process.env.SQLNEST_X); process.stderr.write('err'); process.exit(3)"
				],
				{ cwd: tmpdir(), env: { SQLNEST_X: "out" }, timeoutMs: 10_000 }
			)
		).toEqual({ code: 3, stdout: "out", stderr: "err" });
	});

	it("délai dépassé : le process est arrêté", async () => {
		const run = await runTool(node, ["-e", "setTimeout(() => {}, 10000)"], {
			cwd: tmpdir(),
			env: {},
			timeoutMs: 100
		});
		expect(run.code).toBe(124);
	});
});
