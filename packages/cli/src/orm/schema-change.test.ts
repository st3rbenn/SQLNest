import type { Connection } from "@sqlnest/engine";
import {
	applyDdlToSchema,
	type Field,
	lowerDDL,
	parse,
	type SchemaModel,
	tokenize
} from "@sqlnest/snql";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalConnectionProject } from "../services/local-connections";
import {
	type OrmAdapter,
	type SchemaChange,
	SchemaChangeError
} from "./adapter";
import { applySchemaChange } from "./schema-change";

const field = (name: string, type: Field["type"]): Field => ({
	name,
	type,
	nullable: false,
	source: "declared"
});

const BEFORE: SchemaModel = {
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

const SRC = "add column nickname string nullable into agency";
const AFTER = applyDdlToSchema(
	BEFORE,
	lowerDDL(parse(tokenize(SRC)) as Parameters<typeof lowerDDL>[0], BEFORE, {
		ormProfile: "prisma"
	})
);
const MIGRATION = "20261026083015_add_agency_nickname";

let calls: string[];
let changes: SchemaChange[];

function adapter(overrides: Partial<OrmAdapter> = {}): OrmAdapter {
	const step =
		(name: string, run?: () => void) =>
		async (change: SchemaChange): Promise<void> => {
			calls.push(name);
			changes.push(change);
			run?.();
		};
	return {
		orm: "prisma",
		ddlOptions: () => ({ ormProfile: "prisma" }),
		preflight: step("preflight"),
		writeMigration: async () => {
			calls.push("writeMigration");
			return {
				name: MIGRATION,
				files: [`prisma/migrations/${MIGRATION}/migration.sql`],
				undo: () => calls.push("undo migration")
			};
		},
		patchModel: async () => {
			calls.push("patchModel");
			return {
				files: ["prisma/schema.prisma"],
				undo: () => calls.push("undo model")
			};
		},
		validate: step("validate"),
		apply: step("apply"),
		rollback: step("rollback"),
		check: async (_change, _migration, applied) => {
			calls.push(`check applied=${applied}`);
			return [
				{ name: "model-database", ok: true },
				{ name: "history-model", ok: true }
			];
		},
		...overrides
	};
}

function connection(...schemas: SchemaModel[]): Connection {
	const introspect = vi.fn(async () => BEFORE);
	for (const s of schemas) introspect.mockResolvedValueOnce(s);
	const execute = vi.fn(async () => ({ columns: [], rows: [], rowCount: 0 }));
	return { engine: "postgres", introspect, execute } as unknown as Connection;
}

const PROJECT: LocalConnectionProject = {
	path: "/Users/dev/apps/api",
	orm: "prisma",
	apply: true
};

const run = (
	a: OrmAdapter,
	conn: Connection,
	overrides: { project?: LocalConnectionProject; src?: string } = {}
) =>
	applySchemaChange(
		{
			project: overrides.project ?? PROJECT,
			src: overrides.src ?? SRC,
			databaseUrl: "postgres://u@localhost/app",
			connection: conn,
			env: {}
		},
		{ prisma: a }
	);

const fail = (message: string) => () => {
	throw new SchemaChangeError(message);
};

describe("applySchemaChange (ADR-037 D3, D4, D5)", () => {
	beforeEach(() => {
		calls = [];
		changes = [];
	});

	it("succès : migration, modèle, validation, base, puis contrôles — structure conforme", async () => {
		const result = await run(adapter(), connection(BEFORE, AFTER));
		expect(calls).toEqual([
			"preflight",
			"writeMigration",
			"patchModel",
			"validate",
			"apply",
			"check applied=true"
		]);
		expect(result).toEqual({
			orm: "prisma",
			migration: MIGRATION,
			files: [
				`prisma/migrations/${MIGRATION}/migration.sql`,
				"prisma/schema.prisma"
			],
			applied: true,
			checks: [
				{ name: "model-database", ok: true },
				{ name: "history-model", ok: true },
				{ name: "structure", ok: true }
			]
		});
	});

	it("la migration porte le SNQL d'origine et le DDL compilé sur l'introspection fraîche", async () => {
		await run(adapter(), connection(BEFORE, AFTER));
		const change = changes[0] as SchemaChange;
		expect(change.plan.kind).toBe("add-column");
		expect(change.before).toBe(BEFORE);
		expect(
			change.sql.startsWith(
				`-- SQLNest : ${SRC}\nALTER TABLE "agency" ADD COLUMN "nickname"`
			)
		).toBe(true);
	});

	it("échec de l'application : historique marqué annulé, puis fichiers remis du dernier au premier", async () => {
		await expect(
			run(
				adapter({ apply: async () => fail("P3018 : doublons")() }),
				connection(BEFORE)
			)
		).rejects.toThrow("P3018 : doublons");
		expect(calls).toEqual([
			"preflight",
			"writeMigration",
			"patchModel",
			"validate",
			"rollback",
			"undo model",
			"undo migration"
		]);
	});

	it("retour arrière de l'historique en échec : signalé avec l'erreur d'origine", async () => {
		await expect(
			run(
				adapter({
					apply: async () => fail("P3018 : doublons")(),
					rollback: async () => fail("P1001 : base injoignable")()
				}),
				connection(BEFORE)
			)
		).rejects.toThrow(
			"P3018 : doublons\n(Retour arrière de l'historique incomplet : P1001 : base injoignable)"
		);
		expect(calls.slice(-2)).toEqual(["undo model", "undo migration"]);
	});

	it("index Postgres en échec : l'index invalide laissé par CONCURRENTLY est retiré", async () => {
		const conn = connection(BEFORE);
		// Contrôle du catalogue : l'index est resté invalide.
		vi.mocked(conn.execute).mockResolvedValueOnce({
			columns: [],
			rows: [{ "?column?": 1 }],
			rowCount: 1
		});
		await expect(
			run(adapter({ apply: async () => fail("P3018 : doublons")() }), conn, {
				src: "add unique index (name) into agency"
			})
		).rejects.toThrow(/^P3018 : doublons$/);
		expect(conn.execute).toHaveBeenLastCalledWith(
			expect.objectContaining({
				text: 'DROP INDEX CONCURRENTLY IF EXISTS "agency_name_key"'
			})
		);
	});

	it("base pas revenue à l'état d'avant : signalé", async () => {
		await expect(
			run(
				adapter({ apply: async () => fail("P3018")() }),
				connection(BEFORE, AFTER)
			)
		).rejects.toThrow(
			"P3018\n(La base n'est pas revenue à l'état d'avant : column agency.nickname :"
		);
	});

	it("échec de la validation : fichiers remis, base non touchée", async () => {
		await expect(
			run(
				adapter({ validate: async () => fail("P1012")() }),
				connection(BEFORE)
			)
		).rejects.toThrow("P1012");
		expect(calls).toEqual([
			"preflight",
			"writeMigration",
			"patchModel",
			"undo model",
			"undo migration"
		]);
	});

	it("échec du patch : la migration écrite est retirée", async () => {
		await expect(
			run(
				adapter({ patchModel: async () => fail("modèle introuvable")() }),
				connection(BEFORE)
			)
		).rejects.toThrow("modèle introuvable");
		expect(calls).toEqual(["preflight", "writeMigration", "undo migration"]);
	});

	it("préalable en échec (migration en attente) : rien n'est écrit", async () => {
		await expect(
			run(
				adapter({ preflight: async () => fail("1 migration en attente")() }),
				connection(BEFORE)
			)
		).rejects.toThrow("1 migration en attente");
		expect(calls).toEqual([]);
	});

	it("apply = false : écrit et validé, base non touchée, structure non contrôlée", async () => {
		const conn = connection(BEFORE);
		const result = await run(adapter(), conn, {
			project: { ...PROJECT, apply: false }
		});
		expect(calls).toEqual([
			"preflight",
			"writeMigration",
			"patchModel",
			"validate",
			"check applied=false"
		]);
		expect(result.applied).toBe(false);
		expect(result.checks.at(-1)).toEqual({
			name: "structure",
			skipped: "base non touchée (apply = false)"
		});
		expect(conn.introspect).toHaveBeenCalledOnce();
	});

	it("écart de structure : rapporté, rien n'est défait", async () => {
		const result = await run(adapter(), connection(BEFORE, BEFORE));
		const structure = result.checks.at(-1);
		expect(structure).toMatchObject({ name: "structure", ok: false });
		expect(structure?.differences?.length).toBeGreaterThan(0);
		expect(calls.some((c) => c.startsWith("undo") || c === "rollback")).toBe(
			false
		);
	});

	it("contrôles natifs en échec : contrôle non exécuté, pas d'erreur", async () => {
		const result = await run(
			adapter({ check: async () => fail("shadow refusée")() }),
			connection(BEFORE, AFTER)
		);
		expect(result.checks).toEqual([
			{ name: "model-database", skipped: "shadow refusée" },
			{ name: "structure", ok: true }
		]);
	});

	it("noms retenus par le patch renvoyés dans la réponse", async () => {
		const names = { model: "AgencyTag" };
		const result = await run(
			adapter({
				patchModel: async () => ({ files: [], names, undo: () => undefined })
			}),
			connection(BEFORE, AFTER)
		);
		expect(result.names).toBe(names);
	});

	it("pas une instruction DDL : refusée avant toute lecture de la base", async () => {
		const conn = connection();
		await expect(
			run(adapter(), conn, { src: "remove from agency where id = 1" })
		).rejects.toThrow("Un changement de schéma attend une instruction DDL");
		expect(conn.introspect).not.toHaveBeenCalled();
	});

	it("ORM dont SQLNest n'écrit pas encore les migrations", async () => {
		await expect(
			run(adapter(), connection(), {
				project: { ...PROJECT, orm: "doctrine" }
			})
		).rejects.toThrow("SQLNest n'écrit pas encore les migrations Doctrine");
	});
});
