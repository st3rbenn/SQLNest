import { describe, expect, it } from "vitest";
import { ConnectionClosedError } from "../errors";
import { runQuery } from "../run";
import { mongoAdapter } from "./adapter";
import { resolveMongoConfig } from "./config";

/**
 * Tests d'intégration : nécessitent un vrai MongoDB.
 * Lancer `pnpm db:up`, puis exporter
 * `SNQL_TEST_MONGO_URL=mongodb://sqlnest:sqlnest@localhost:27017/sqlnest_demo?authSource=admin`.
 * Sans cette variable, tout le bloc est **sauté**.
 */
const MONGO_URL = process.env.SNQL_TEST_MONGO_URL ?? "";
const hasMongo = MONGO_URL !== "";
const loadConfig = () => resolveMongoConfig({ url: MONGO_URL });

describe.skipIf(!hasMongo)("mongodb adapter (intégration)", () => {
	it("connect → ping → close", async () => {
		const conn = await mongoAdapter.connect(loadConfig());
		try {
			const ping = await conn.ping();
			expect(ping.latencyMs).toBeGreaterThanOrEqual(0);
		} finally {
			await conn.close();
		}
	}, 20_000);

	it("ping après close lève ConnectionClosedError", async () => {
		const conn = await mongoAdapter.connect(loadConfig());
		await conn.close();
		await expect(conn.ping()).rejects.toBeInstanceOf(ConnectionClosedError);
	}, 20_000);

	it("introspect : schéma inféré par sampling (collections + relation)", async () => {
		const conn = await mongoAdapter.connect(loadConfig());
		try {
			const schema = await conn.introspect();
			expect(schema.engine).toBe("mongodb");

			const names = schema.collections.map((c) => c.name);
			expect(names).toContain("users");
			expect(names).toContain("orders");

			const users = schema.collections.find((c) => c.name === "users");
			expect(users?.source).toBe("inferred");
			expect(users?.fields.find((f) => f.name === "email")?.type).toBe(
				"string"
			);

			// Relation inférée orders.user_id -> users (heuristique de nommage).
			const rel = schema.relations.find((r) => r.from.collection === "orders");
			expect(rel?.to.collection).toBe("users");
			expect(rel?.origin).toBe("naming-heuristic");
		} finally {
			await conn.close();
		}
	}, 20_000);

	it("runQuery : le codegen Mongo touche enfin une vraie base", async () => {
		const conn = await mongoAdapter.connect(loadConfig());
		try {
			const rs = await runQuery(
				conn,
				"get users | where is_active = true | pick email"
			);
			const emails = rs.rows.map((row) => row.email).sort();
			expect(emails).toEqual(["ada@example.com", "alan@example.com"]);
		} finally {
			await conn.close();
		}
	}, 20_000);
});
