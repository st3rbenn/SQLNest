import { describe, expect, it } from "vitest";
import { planFor } from "../index";
import type { SchemaModel } from "../schema/model";
import { inferResultColumns } from "./infer-column-types";

const SCHEMA: SchemaModel = {
	engine: "postgres",
	collections: [
		{
			name: "users",
			source: "declared",
			primaryKey: ["id"],
			fields: [
				{ name: "id", type: "bigint", nullable: false, source: "declared" },
				{ name: "email", type: "string", nullable: false, source: "declared" },
				{
					name: "display_name",
					type: "string",
					nullable: true,
					source: "declared"
				},
				{
					name: "is_active",
					type: "bool",
					nullable: false,
					source: "declared"
				},
				{
					name: "created_at",
					type: "date",
					nullable: false,
					source: "declared"
				}
			]
		},
		{
			name: "orders",
			source: "declared",
			primaryKey: ["id"],
			fields: [
				{ name: "id", type: "bigint", nullable: false, source: "declared" },
				{
					name: "user_id",
					type: "bigint",
					nullable: false,
					source: "declared"
				},
				{
					name: "status",
					type: "string",
					nullable: false,
					source: "declared"
				},
				{
					name: "total_cents",
					type: "bigint",
					nullable: false,
					source: "declared"
				}
			]
		}
	],
	relations: [
		{
			from: { collection: "orders", fields: ["user_id"] },
			to: { collection: "users", fields: ["id"] },
			kind: "many-to-one",
			origin: "foreign-key",
			confidence: 1
		}
	]
};

describe("inferResultColumns — scan seul", () => {
	it("retourne tous les fields de la collection dans l'ordre du schéma", () => {
		const plan = planFor("get users", "postgres");
		const cols = inferResultColumns(plan, SCHEMA);
		expect(cols).toEqual([
			{ name: "id", type: "bigint", nullable: false },
			{ name: "email", type: "string", nullable: false },
			{ name: "display_name", type: "string", nullable: true },
			{ name: "is_active", type: "bool", nullable: false },
			{ name: "created_at", type: "date", nullable: false }
		]);
	});

	it("collection absente du schéma → [] (safe fallback, pas d'erreur)", () => {
		const plan = planFor("get ghosts", "postgres");
		expect(inferResultColumns(plan, SCHEMA)).toEqual([]);
	});
});

describe("inferResultColumns — projection pick", () => {
	it("pick direct sur la source", () => {
		const plan = planFor("get users pick id, email", "postgres");
		expect(inferResultColumns(plan, SCHEMA)).toEqual([
			{ name: "id", type: "bigint", nullable: false },
			{ name: "email", type: "string", nullable: false }
		]);
	});

	it("field inconnu → unknown + nullable", () => {
		const plan = planFor("get users pick id, ghost_col", "postgres");
		expect(inferResultColumns(plan, SCHEMA)).toEqual([
			{ name: "id", type: "bigint", nullable: false },
			{ name: "ghost_col", type: "unknown", nullable: true }
		]);
	});
});

describe("inferResultColumns — filter/sort/limit transparents", () => {
	it("filter avant pick n'altère pas les types", () => {
		const plan = planFor(
			"get users where is_active = true pick email",
			"postgres"
		);
		expect(inferResultColumns(plan, SCHEMA)).toEqual([
			{ name: "email", type: "string", nullable: false }
		]);
	});

	it("pick + sort + limit → colonnes du pick", () => {
		const plan = planFor(
			"get users pick id, email sort id desc limit 10",
			"postgres"
		);
		expect(inferResultColumns(plan, SCHEMA)).toEqual([
			{ name: "id", type: "bigint", nullable: false },
			{ name: "email", type: "string", nullable: false }
		]);
	});

	it("scan seul + sort/limit sans pick → toutes les cols du schéma", () => {
		const plan = planFor("get users sort id limit 5", "postgres");
		expect(inferResultColumns(plan, SCHEMA).map((c) => c.name)).toEqual([
			"id",
			"email",
			"display_name",
			"is_active",
			"created_at"
		]);
	});
});

describe("inferResultColumns — join embed", () => {
	it("ajoute un champ array pour le join, nullable false", () => {
		const plan = planFor(
			"get users with orders on id = user_id",
			"postgres"
		);
		const cols = inferResultColumns(plan, SCHEMA);
		expect(cols.at(-1)).toEqual({
			name: "orders",
			type: "array",
			nullable: false
		});
	});

	it("pick sur l'alias du join → type array", () => {
		const plan = planFor(
			"get users with orders as ords on id = user_id pick ords",
			"postgres"
		);
		expect(inferResultColumns(plan, SCHEMA)).toEqual([
			{ name: "ords", type: "array", nullable: false }
		]);
	});
});

describe("inferResultColumns — aliases source", () => {
	it("get X as u pick u.email → strip alias, type direct depuis schéma", () => {
		const plan = planFor(
			"get users as u pick u.email, u.display_name",
			"postgres"
		);
		expect(inferResultColumns(plan, SCHEMA)).toEqual([
			{ name: "email", type: "string", nullable: false },
			{ name: "display_name", type: "string", nullable: true }
		]);
	});
});
