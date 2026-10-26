import { Decimal128, MongoClient } from "mongodb";
import { describe, expect, it } from "vitest";
import { runQuery } from "../run";
import { mongoAdapter } from "./adapter";
import { resolveMongoConfig } from "./config";

/**
 * Littéraux décimaux des filtres sur un vrai MongoDB (ADR-029 D17) :
 * `SNQL_TEST_MONGO_URL=mongodb://localhost:27017/sqlnest_demo?directConnection=true`.
 * Sans cette variable, tout le bloc est sauté. Tables `e2d_*`, supprimées ensuite.
 */
const MONGO_URL = process.env.SNQL_TEST_MONGO_URL ?? "";
const hasMongo = MONGO_URL !== "";
const loadConfig = () => resolveMongoConfig({ url: MONGO_URL });

describe.skipIf(!hasMongo)(
	"mongodb adapter — filtres décimaux (ADR-029 D17)",
	() => {
		it("decimal et float : égalité, in, !=, bornes, en lecture et dans les filtres d'écriture", async () => {
			const conn = await mongoAdapter.connect(loadConfig());
			const codes = async (where: string) =>
				(
					await runQuery(conn, `find e2d_t where ${where} pick code sort code`)
				).rows.map((r) => r.code);
			try {
				await runQuery(conn, "drop table e2d_t if exists");
				await runQuery(
					conn,
					"create table e2d_t { code: text, d: decimal nullable, f: float nullable }"
				);
				await runQuery(
					conn,
					'add [{code: "a", d: 0.1, f: 0.1}, {code: "b", d: 0.2, f: 0.2}, {code: "c", d: 1.123456789012345678, f: 2.5}] into e2d_t'
				);
				await runQuery(conn, 'add {code: "z"} into e2d_t');

				expect(await codes("d = 0.1")).toEqual(["a"]);
				expect(await codes("f = 0.1")).toEqual(["a"]);
				expect(await codes("d = 1.123456789012345678")).toEqual(["c"]);
				expect(await codes("d in [0.1, 0.2]")).toEqual(["a", "b"]);
				expect(await codes("d != 0.1")).toEqual(["b", "c"]);
				expect(await codes("not (d = 0.1)")).toEqual(["b", "c"]);
				expect(await codes("d >= 0.1")).toEqual(["a", "b", "c"]);
				expect(await codes("d > 0.1")).toEqual(["b", "c"]);
				expect(await codes("d <= 0.1")).toEqual(["a"]);
				expect(await codes("d < 0.2")).toEqual(["a"]);
				expect(await codes("d >= 0.1 and d < 0.2")).toEqual(["a"]);
				expect(await codes("f >= 0.1")).toEqual(["a", "b", "c"]);
				expect(await codes("f <= 0.1")).toEqual(["a"]);

				const updated = await runQuery(
					conn,
					"update e2d_t where d = 0.1 set f = 9"
				);
				expect(updated.rowCount).toBe(1);
				const removed = await runQuery(
					conn,
					"remove from e2d_t where d >= 0.2"
				);
				expect(removed.rowCount).toBe(2);
				expect(
					(await runQuery(conn, "find e2d_t pick code, f sort code")).rows
				).toEqual([{ code: "a", f: 9 }, { code: "z" }]);
			} finally {
				await runQuery(conn, "drop table e2d_t if exists");
				await conn.close();
			}
		}, 60_000);

		it("collection sans validateur : double et Decimal128 mêlés, chacun comparé sous son type", async () => {
			const conn = await mongoAdapter.connect(loadConfig());
			const client = await MongoClient.connect(MONGO_URL);
			const keys = async (where: string) =>
				(
					await runQuery(conn, `find e2d_mixed where ${where} pick k sort k`)
				).rows.map((r) => r.k);
			try {
				const col = client.db().collection("e2d_mixed");
				await col.drop().catch(() => undefined);
				await col.insertMany([
					{ k: "dbl", v: 0.1 },
					{ k: "dec", v: Decimal128.fromString("0.1") },
					{ k: "int", v: 1 }
				]);
				expect(await keys("v = 0.1")).toEqual(["dbl", "dec"]);
				expect(await keys("v >= 0.1")).toEqual(["dbl", "dec", "int"]);
				expect(await keys("v > 0.1")).toEqual(["int"]);
				expect(await keys("v < 1")).toEqual(["dbl", "dec"]);
				expect(await keys("v in [0.1]")).toEqual(["dbl", "dec"]);
			} finally {
				await client
					.db()
					.collection("e2d_mixed")
					.drop()
					.catch(() => undefined);
				await client.close();
				await conn.close();
			}
		}, 60_000);
	}
);
