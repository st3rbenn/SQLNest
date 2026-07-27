import { describe, expect, it } from "vitest";
import type { Row } from "./index";
import { compensate, compile, planFor } from "./index";

function sql(source: string): string {
	const { native } = compile(source, { engine: "postgres" });
	if (native.kind !== "sql") {
		throw new Error("attendu sql");
	}
	return native.text;
}

function mongo(source: string): readonly Record<string, unknown>[] {
	const { native } = compile(source, { engine: "mongodb" });
	if (native.kind !== "mongo") {
		throw new Error("attendu mongo");
	}
	return native.pipeline;
}

describe("join (with) — Postgres embed via json_agg", () => {
	it("sous-requête json_agg corrélée", () => {
		expect(sql("get users | with orders on id = user_id")).toBe(
			`SELECT "users".*, (SELECT COALESCE(json_agg("orders".*), '[]'::json) FROM "orders" WHERE "orders"."user_id" = "users"."id") AS "orders" FROM "users"`
		);
	});

	it("respecte l'alias de la table de base", () => {
		expect(sql("get users as u | with orders on id = user_id")).toBe(
			`SELECT "u".*, (SELECT COALESCE(json_agg("orders".*), '[]'::json) FROM "orders" WHERE "orders"."user_id" = "u"."id") AS "orders" FROM "users" AS "u"`
		);
	});

	it("localField qualifié par l'alias source (u.id) est strippé", () => {
		expect(sql("get users as u | with orders on u.id = user_id")).toBe(
			`SELECT "u".*, (SELECT COALESCE(json_agg("orders".*), '[]'::json) FROM "orders" WHERE "orders"."user_id" = "u"."id") AS "orders" FROM "users" AS "u"`
		);
	});

	it("pick du champ joint → sous-requête sous l'alias", () => {
		expect(
			sql("get users | with orders on id = user_id | pick name, orders")
		).toBe(
			`SELECT "name", (SELECT COALESCE(json_agg("orders".*), '[]'::json) FROM "orders" WHERE "orders"."user_id" = "users"."id") AS "orders" FROM "users"`
		);
	});

	it("self-join : la table interne est aliasée (pas de shadowing)", () => {
		expect(sql("get orders | with orders as parent on parent_id = id")).toBe(
			`SELECT "orders".*, (SELECT COALESCE(json_agg("__j0".*), '[]'::json) FROM "orders" AS "__j0" WHERE "__j0"."id" = "orders"."parent_id") AS "parent" FROM "orders"`
		);
	});
});

describe("join (with) — MongoDB embed via $lookup", () => {
	it("$lookup natif", () => {
		expect(mongo("get users | with orders on id = user_id")).toEqual([
			{
				$lookup: {
					from: "orders",
					localField: "id",
					foreignField: "user_id",
					as: "orders"
				}
			}
		]);
	});

	it("strippe l'alias de base du localField", () => {
		expect(mongo("get users as u | with orders on u.id = user_id")).toEqual([
			{
				$lookup: {
					from: "orders",
					localField: "id",
					foreignField: "user_id",
					as: "orders"
				}
			}
		]);
	});

	it("alias de la collection jointe", () => {
		expect(mongo("get users | with orders as cmds on id = user_id")).toEqual([
			{
				$lookup: {
					from: "orders",
					localField: "id",
					foreignField: "user_id",
					as: "cmds"
				}
			}
		]);
	});
});

describe("join (with) — planner", () => {
	it("Postgres et Mongo poussent le join nativement", () => {
		expect(
			planFor("get users | with orders on id = user_id", "postgres").fullyPushed
		).toBe(true);
		expect(
			planFor("get users | with orders on id = user_id", "mongodb").fullyPushed
		).toBe(true);
	});

	it("KV n'a pas de join → compensé", () => {
		const p = planFor("get users | with orders on id = user_id", "kv");
		expect(p.pushdown.op).toBe("scan");
		expect(p.compensation.map((o) => o.op)).toEqual(["join"]);
	});
});

describe("join (with) — compensation runtime (embed en mémoire)", () => {
	const users: Row[] = [
		{ id: 1, name: "Bob" },
		{ id: 2, name: "Al" }
	];
	const orders: Row[] = [
		{ id: 10, user_id: 1, total: 5 },
		{ id: 11, user_id: 1, total: 8 },
		{ id: 12, user_id: 2, total: 3 }
	];

	it("embed les lignes droites matchées", () => {
		const p = planFor("get users | with orders on id = user_id", "kv");
		expect(compensate(p.compensation, users, { orders })).toEqual([
			{
				id: 1,
				name: "Bob",
				orders: [
					{ id: 10, user_id: 1, total: 5 },
					{ id: 11, user_id: 1, total: 8 }
				]
			},
			{ id: 2, name: "Al", orders: [{ id: 12, user_id: 2, total: 3 }] }
		]);
	});

	it("left sans match → tableau vide", () => {
		const p = planFor("get users | with orders on id = user_id", "kv");
		expect(
			compensate(p.compensation, [{ id: 99, name: "Zoe" }], { orders })
		).toEqual([{ id: 99, name: "Zoe", orders: [] }]);
	});

	it("sans données source → erreur (couche connexion requise)", () => {
		const p = planFor("get users | with orders on id = user_id", "kv");
		expect(() => compensate(p.compensation, users)).toThrow(
			/couche connexion|donnée/i
		);
	});

	it("clés entières > 2^53 restent distinctes (précision bigint)", () => {
		const p = planFor("get users | with orders on id = user_id", "kv");
		const bigUsers: Row[] = [
			{ id: 9007199254740993n, name: "A" },
			{ id: 9007199254740992n, name: "B" }
		];
		const bigOrders: Row[] = [{ id: 10, user_id: 9007199254740992n }];
		expect(compensate(p.compensation, bigUsers, { orders: bigOrders })).toEqual(
			[
				{ id: 9007199254740993n, name: "A", orders: [] },
				{
					id: 9007199254740992n,
					name: "B",
					orders: [{ id: 10, user_id: 9007199254740992n }]
				}
			]
		);
	});
});
