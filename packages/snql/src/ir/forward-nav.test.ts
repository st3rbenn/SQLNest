import { describe, expect, it } from "vitest";
import { compile } from "../index";
import type { SchemaModel } from "../schema/model";

/** Schéma orders → users (FK sortante user_id → id), avec `refs` déclarés. */
const SCHEMA: SchemaModel = {
	engine: "postgres",
	collections: [
		{
			name: "orders",
			source: "declared",
			primaryKey: ["id"],
			fields: [
				{ name: "id", type: "bigint", nullable: false, source: "declared" },
				{ name: "user_id", type: "bigint", nullable: true, source: "declared" },
				{ name: "total", type: "int", nullable: false, source: "declared" }
			]
		},
		{
			name: "users",
			source: "declared",
			primaryKey: ["id"],
			fields: [
				{ name: "id", type: "bigint", nullable: false, source: "declared" },
				{ name: "name", type: "string", nullable: false, source: "declared" }
			]
		}
	],
	relations: [],
	refs: [
		{
			name: "fk_orders_user_id_users",
			fromCollection: "orders",
			fromColumn: "user_id",
			toCollection: "users",
			toColumn: "id",
			onDelete: "cascade",
			onUpdate: "restrict",
			source: "declared"
		}
	]
};

function pg(source: string): string {
	const { native } = compile(source, { engine: "postgres", schema: SCHEMA });
	if (native.kind !== "sql") throw new Error("attendu sql");
	return native.text;
}

function mongo(source: string): readonly Record<string, unknown>[] {
	const { native } = compile(source, { engine: "mongodb", schema: SCHEMA });
	if (native.kind !== "mongo") throw new Error("attendu mongo");
	return native.pipeline;
}

describe("FK/2a forward-nav (ADR-031 D6)", () => {
	it("PG : `pick user.name` → LEFT JOIN implicite + colonne plate", () => {
		expect(pg("find orders pick id, user.name")).toBe(
			`SELECT "id", "user"."name" FROM "orders" LEFT JOIN "users" AS "user" ON "user"."id" = "orders"."user_id"`
		);
	});

	it("PG : nav en `where` injecte aussi le join", () => {
		expect(pg('find orders where user.name = "Alice" pick id')).toBe(
			`SELECT "id" FROM "orders" LEFT JOIN "users" AS "user" ON "user"."id" = "orders"."user_id" WHERE "user"."name" = $1`
		);
	});

	it("Mongo : `pick user.name` → $lookup + $unwind (many→one flat)", () => {
		const pipeline = mongo("find orders pick id, user.name");
		expect(pipeline).toContainEqual({
			$lookup: {
				from: "users",
				localField: "user_id",
				foreignField: "id",
				as: "user"
			}
		});
		expect(pipeline).toContainEqual({
			$unwind: { path: "$user", preserveNullAndEmptyArrays: true }
		});
	});

	it("pas de nav si la colonne est locale (pas de shadow)", () => {
		// `total.x` n'est PAS un nav (total est une colonne locale) → traité comme
		// accès JSON, pas de join injecté.
		const sql = pg("find orders pick total");
		expect(sql).not.toContain("LEFT JOIN");
	});

	it("pas d'injection si aucun nav référencé", () => {
		expect(pg("find orders pick id, total")).toBe(
			`SELECT "id", "total" FROM "orders"`
		);
	});

	it("nav idempotent : un seul join même si le nav est utilisé 2× (pick + where)", () => {
		const sql = pg('find orders where user.name = "Bob" pick user.name');
		// Un seul LEFT JOIN users.
		expect(sql.match(/LEFT JOIN/g)?.length).toBe(1);
	});

	it("l'alias explicite `with` de l'user n'est pas ré-injecté", () => {
		// L'user écrit déjà le join (`with one` flat explicite) → le desugar voit
		// `user` dans les alias existants et n'injecte PAS un second join.
		const sql = pg(
			"find orders with one users as user on user_id = id pick user.name"
		);
		expect(sql.match(/JOIN/g)?.length ?? 0).toBe(1);
	});
});
