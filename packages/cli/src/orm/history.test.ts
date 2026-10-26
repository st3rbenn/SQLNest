import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OrmDetection } from "./detect";
import {
	checkHistory,
	describeHistory,
	describeNoHistory,
	keepsHistory,
	migrationsDir
} from "./history";

describe("checkHistory", () => {
	it("table de l'ORM présente (casse ignorée)", () => {
		expect(checkHistory("sequelize", ["users", "sequelizemeta"])).toEqual({
			table: "SequelizeMeta",
			present: true
		});
	});

	it("table d'un autre ORM : la base est gérée par lui", () => {
		const check = checkHistory("prisma", [
			"users",
			"doctrine_migration_versions"
		]);
		expect(check).toEqual({
			table: "_prisma_migrations",
			present: false,
			other: { orm: "doctrine", table: "doctrine_migration_versions" }
		});
		expect(describeHistory("prisma", check)).toBe(
			"La base est gérée par Doctrine (doctrine_migration_versions), pas par Prisma"
		);
	});

	it("aucune table d'historique : base jamais migrée", () => {
		const check = checkHistory("seaorm", ["users"]);
		expect(check).toEqual({ table: "seaql_migrations", present: false });
		expect(describeHistory("seaorm", check)).toBe(
			"Aucune table seaql_migrations : la base n'a encore reçu aucune migration SeaORM"
		);
	});
});

describe("keepsHistory (ADR-037 D3 bis)", () => {
	it("Prisma sous MongoDB : pas d'historique (db push) ; ailleurs, un historique", () => {
		expect(keepsHistory("prisma", "mongodb")).toBe(false);
		expect(keepsHistory("prisma", "postgres")).toBe(true);
		expect(keepsHistory("doctrine", "mongodb")).toBe(true);
		expect(describeNoHistory("prisma", "mongodb")).toBe(
			"Prisma ne tient pas d'historique de migrations sous MongoDB (db push) : SQLNest applique les changements lui-même"
		);
	});
});

describe("migrationsDir", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "sqlnest-history-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	const detection = (
		orm: OrmDetection["orm"],
		configFile: string
	): OrmDetection => ({
		orm,
		dir,
		configFile: join(dir, configFile)
	});

	it("Prisma : à côté du schéma ; SeaORM : la crate migration ; absent → undefined", () => {
		expect(
			migrationsDir(detection("prisma", "prisma/schema.prisma"))
		).toBeUndefined();
		mkdirSync(join(dir, "prisma", "migrations"), { recursive: true });
		expect(migrationsDir(detection("prisma", "prisma/schema.prisma"))).toBe(
			join(dir, "prisma", "migrations")
		);
		mkdirSync(join(dir, "migration"));
		expect(migrationsDir(detection("seaorm", "Cargo.toml"))).toBe(
			join(dir, "migration")
		);
	});
});
