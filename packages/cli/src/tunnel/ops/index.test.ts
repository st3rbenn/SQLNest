import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Connection } from "@sqlnest/engine";
import type { SchemaModel } from "@sqlnest/snql";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveLocalConnections } from "../../services/local-connections";
import { createSchemaCache, dispatchOp } from "./index";

const SCHEMA: SchemaModel = {
	engine: "postgres",
	collections: [],
	relations: []
};

function fakeConnection(overrides: Partial<Connection> = {}): Connection {
	return {
		engine: "postgres",
		ping: vi.fn(async () => ({ latencyMs: 3, serverVersion: "16" })),
		introspect: vi.fn(async () => SCHEMA),
		close: vi.fn(async () => undefined),
		...overrides
	} as unknown as Connection;
}

function target(conn: Connection) {
	const open = vi.fn(async () => conn);
	return {
		open,
		connectionName: "apollon",
		env: {},
		schema: createSchemaCache()
	};
}

describe("dispatchOp", () => {
	it("op inconnue → échec, aucune connexion ouverte", async () => {
		const conn = fakeConnection();
		const t = target(conn);
		expect(await dispatchOp({ op: "nope" } as never, t)).toEqual({
			ok: false,
			error: "op inconnue"
		});
		expect(t.open).not.toHaveBeenCalled();
	});

	it("ping : connexion ouverte à la demande, fermée après l'op", async () => {
		const conn = fakeConnection();
		const t = target(conn);
		expect(await dispatchOp({ op: "ping" }, t)).toEqual({
			ok: true,
			data: { latencyMs: 3, serverVersion: "16" }
		});
		expect(t.open).toHaveBeenCalledWith("apollon", {});
		expect(conn.close).toHaveBeenCalledOnce();
	});

	it("introspect remplit le cache de schéma", async () => {
		const t = target(fakeConnection());
		await dispatchOp({ op: "introspect" }, t);
		expect(t.schema.get()).toBe(SCHEMA);
	});

	it("une erreur remonte, la connexion est fermée quand même", async () => {
		const conn = fakeConnection({
			ping: vi.fn(async () => {
				throw new Error("ECONNREFUSED");
			})
		});
		await expect(dispatchOp({ op: "ping" }, target(conn))).rejects.toThrow(
			"ECONNREFUSED"
		);
		expect(conn.close).toHaveBeenCalledOnce();
	});
});

describe("projectStatus (ADR-037 D2)", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "sqlnest-project-status-"));
		process.env.SQLNEST_CONFIG_DIR = join(dir, "config");
	});
	afterEach(() => {
		delete process.env.SQLNEST_CONFIG_DIR;
		rmSync(dir, { recursive: true, force: true });
	});

	it("connexion sans projet : non relié, la base n'est pas ouverte", async () => {
		saveLocalConnections({
			version: 1,
			connections: [{ name: "apollon", url: "postgres://u@h/db" }]
		});
		const t = target(fakeConnection());
		expect(await dispatchOp({ op: "projectStatus" }, t)).toEqual({
			ok: true,
			data: { linked: false }
		});
		expect(t.open).not.toHaveBeenCalled();
	});

	it("projet relié : ORM, apply, projet trouvé, table d'historique — jamais le chemin", async () => {
		const project = join(dir, "prisma-app");
		mkdirSync(join(project, "prisma"), { recursive: true });
		writeFileSync(
			join(project, "prisma", "schema.prisma"),
			'datasource db {\n  provider = "postgresql"\n  url = env("DATABASE_URL")\n}'
		);
		saveLocalConnections({
			version: 2,
			connections: [
				{
					name: "apollon",
					url: "postgres://u@h/db",
					project: { path: project, orm: "prisma", apply: false }
				}
			]
		});
		const t = target(
			fakeConnection({
				introspect: vi.fn(async () => ({
					...SCHEMA,
					collections: [
						{ name: "_prisma_migrations", fields: [] },
						{ name: "users", fields: [] }
					]
				})) as unknown as Connection["introspect"]
			})
		);
		const res = await dispatchOp({ op: "projectStatus" }, t);
		expect(res).toEqual({
			ok: true,
			data: {
				linked: true,
				orm: "prisma",
				apply: false,
				projectFound: true,
				historyTable: { name: "_prisma_migrations", present: true }
			}
		});
		expect(JSON.stringify(res)).not.toContain(project);
		// Le schéma lu sert de cache aux ops suivantes.
		expect(t.schema.get()?.collections).toHaveLength(2);
	});

	it("dossier du projet disparu : projectFound false", async () => {
		saveLocalConnections({
			version: 2,
			connections: [
				{
					name: "apollon",
					url: "postgres://u@h/db",
					project: { path: join(dir, "gone"), orm: "prisma", apply: true }
				}
			]
		});
		const res = await dispatchOp(
			{ op: "projectStatus" },
			target(fakeConnection())
		);
		expect(res).toMatchObject({
			ok: true,
			data: { linked: true, projectFound: false }
		});
	});
});
