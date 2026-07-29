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

/**
 * Mutations réelles. Tout se passe dans une collection jetable (`snql_write_probe`)
 * pour ne jamais toucher le seed `users`/`orders` des tests de lecture.
 */
describe.skipIf(!hasMongo)("mongodb — mutations (intégration)", () => {
	const PROBE = "snql_write_probe";
	const wipe = (conn: Awaited<ReturnType<typeof mongoAdapter.connect>>) =>
		runQuery(conn, `remove from ${PROBE}`);

	it("insert : documents réels, _id généré rendu (parité RETURNING)", async () => {
		const conn = await mongoAdapter.connect(loadConfig());
		try {
			await wipe(conn);
			const inserted = await runQuery(
				conn,
				`add [{sku: "a", qty: 1}, {sku: "b", qty: 2}] into ${PROBE}`
			);
			expect(inserted.rowCount).toBe(2);
			expect(inserted.rows.map((row) => row.sku).sort()).toEqual(["a", "b"]);
			// `_id` généré par Mongo, normalisé en chaîne.
			expect(typeof inserted.rows[0]?._id).toBe("string");

			const read = await runQuery(conn, `get ${PROBE} | pick sku`);
			expect(read.rowCount).toBe(2);
		} finally {
			await wipe(conn);
			await conn.close();
		}
	}, 20_000);

	it("update : filtre + $set, rowCount = lignes touchées", async () => {
		const conn = await mongoAdapter.connect(loadConfig());
		try {
			await wipe(conn);
			await runQuery(
				conn,
				`add [{sku: "a", qty: 1}, {sku: "b", qty: 1}] into ${PROBE}`
			);

			const updated = await runQuery(
				conn,
				`update ${PROBE} | where sku = "a" | set qty = 42`
			);
			expect(updated.rowCount).toBe(1);
			// Asymétrie assumée avec Postgres : pas de RETURNING multi-documents.
			expect(updated.rows).toEqual([]);

			const check = await runQuery(
				conn,
				`get ${PROBE} | where sku = "a" | pick qty`
			);
			expect(check.rows[0]?.qty).toBe(42);
		} finally {
			await wipe(conn);
			await conn.close();
		}
	}, 20_000);

	it("update non filtré : porte sur tous les documents (ADR-012)", async () => {
		const conn = await mongoAdapter.connect(loadConfig());
		try {
			await wipe(conn);
			await runQuery(
				conn,
				`add [{sku: "a", qty: 1}, {sku: "b", qty: 2}] into ${PROBE}`
			);

			const updated = await runQuery(conn, `update ${PROBE} | set qty = 7`);
			expect(updated.rowCount).toBe(2);

			const check = await runQuery(conn, `get ${PROBE} | pick qty`);
			expect(check.rows.map((row) => row.qty)).toEqual([7, 7]);
		} finally {
			await wipe(conn);
			await conn.close();
		}
	}, 20_000);

	it("update référençant un champ (forme pipeline) sur de vraies données", async () => {
		const conn = await mongoAdapter.connect(loadConfig());
		try {
			await wipe(conn);
			await runQuery(conn, `add {sku: "a", qty: 3, total: 0} into ${PROBE}`);

			const updated = await runQuery(
				conn,
				`update ${PROBE} | where sku = "a" | set total = qty`
			);
			expect(updated.rowCount).toBe(1);

			const check = await runQuery(
				conn,
				`get ${PROBE} | where sku = "a" | pick total`
			);
			expect(check.rows[0]?.total).toBe(3);
		} finally {
			await wipe(conn);
			await conn.close();
		}
	}, 20_000);

	it("forme pipeline : une chaîne `$…` est écrite telle quelle, pas résolue", async () => {
		const conn = await mongoAdapter.connect(loadConfig());
		try {
			await wipe(conn);
			await runQuery(conn, `add {sku: "a", qty: 3, label: "x"} into ${PROBE}`);

			// `total = qty` force la forme pipeline ; sans `$literal`, Mongo lirait
			// "$qty" comme un chemin de champ et écrirait 3 dans `label`.
			await runQuery(
				conn,
				`update ${PROBE} | where sku = "a" | set label = "$qty", total = qty`
			);

			const check = await runQuery(
				conn,
				`get ${PROBE} | where sku = "a" | pick label, total`
			);
			expect(check.rows[0]?.label).toBe("$qty");
			expect(check.rows[0]?.total).toBe(3);
		} finally {
			await wipe(conn);
			await conn.close();
		}
	}, 20_000);

	it("delete : filtré puis non filtré", async () => {
		const conn = await mongoAdapter.connect(loadConfig());
		try {
			await wipe(conn);
			await runQuery(
				conn,
				`add [{sku: "a", qty: 1}, {sku: "b", qty: 2}, {sku: "c", qty: 3}] into ${PROBE}`
			);

			const removed = await runQuery(
				conn,
				`remove from ${PROBE} | where qty > 2`
			);
			expect(removed.rowCount).toBe(1);
			expect(removed.rows).toEqual([]);

			const rest = await runQuery(conn, `get ${PROBE} | pick sku`);
			expect(rest.rowCount).toBe(2);

			const all = await runQuery(conn, `remove from ${PROBE}`);
			expect(all.rowCount).toBe(2);
			expect((await runQuery(conn, `get ${PROBE}`)).rowCount).toBe(0);
		} finally {
			await wipe(conn);
			await conn.close();
		}
	}, 20_000);

	it("delete sans correspondance : 0 ligne, pas d'erreur", async () => {
		const conn = await mongoAdapter.connect(loadConfig());
		try {
			await wipe(conn); // auto-suffisant (pas de dépendance à l'ordre des tests)
			const removed = await runQuery(
				conn,
				`remove from ${PROBE} | where sku = "absent"`
			);
			expect(removed.rowCount).toBe(0);
		} finally {
			await conn.close();
		}
	}, 20_000);
});

/**
 * Corrections issues de la review adversariale (perte de données / fidélité BSON).
 * Chaque test échouerait sans le correctif correspondant.
 */
describe.skipIf(!hasMongo)("mongodb — mutations : corrections review", () => {
	const PROBE = "snql_write_probe";
	const wipe = (conn: Awaited<ReturnType<typeof mongoAdapter.connect>>) =>
		runQuery(conn, `remove from ${PROBE}`);

	it("`!=` n'efface PAS les documents où le champ est absent/null (parité 3VL)", async () => {
		const conn = await mongoAdapter.connect(loadConfig());
		try {
			await wipe(conn);
			await runQuery(conn, `add {sku: "a", age: 30} into ${PROBE}`);
			await runQuery(conn, `add {sku: "b", age: 40} into ${PROBE}`);
			await runQuery(conn, `add {sku: "c", age: null} into ${PROBE}`);
			await runQuery(conn, `add {sku: "d"} into ${PROBE}`); // age absent

			// Seul "b" (age 40) doit partir — comme Postgres (a=30 exclu, null/absent UNKNOWN).
			const removed = await runQuery(
				conn,
				`remove from ${PROBE} | where age != 30`
			);
			expect(removed.rowCount).toBe(1);

			const survivors = await runQuery(conn, `get ${PROBE} | pick sku`);
			expect(survivors.rows.map((r) => r.sku).sort()).toEqual(["a", "c", "d"]);
		} finally {
			await wipe(conn);
			await conn.close();
		}
	}, 20_000);

	it('`where _id = "<hex>"` matche, `_id != "<hex>"` épargne (ObjectId réhydraté)', async () => {
		const conn = await mongoAdapter.connect(loadConfig());
		try {
			await wipe(conn);
			// _id générés par Mongo = ObjectId ; la lecture les rend en chaîne hex.
			const ins = await runQuery(
				conn,
				`add [{sku: "x"}, {sku: "y"}, {sku: "z"}] into ${PROBE}`
			);
			const targetId = ins.rows[0]?._id as string;
			expect(typeof targetId).toBe("string");

			const match = await runQuery(
				conn,
				`get ${PROBE} | where _id = "${targetId}" | pick sku`
			);
			expect(match.rows.map((r) => r.sku)).toEqual(["x"]);

			// Sans réhydratation, `_id != "hex"` matcherait TOUT → collection vidée.
			const removed = await runQuery(
				conn,
				`remove from ${PROBE} | where _id != "${targetId}"`
			);
			expect(removed.rowCount).toBe(2);
			const rest = await runQuery(conn, `get ${PROBE} | pick sku`);
			expect(rest.rows.map((r) => r.sku)).toEqual(["x"]);
		} finally {
			await wipe(conn);
			await conn.close();
		}
	}, 20_000);

	it("update forme pipeline : champ source absent → null (pas de suppression de clé)", async () => {
		const conn = await mongoAdapter.connect(loadConfig());
		try {
			await wipe(conn);
			await runQuery(conn, `add {sku: "nf", total: 99} into ${PROBE}`); // pas de `price`

			await runQuery(
				conn,
				`update ${PROBE} | where sku = "nf" | set total = price`
			);
			const check = await runQuery(
				conn,
				`get ${PROBE} | where sku = "nf" | pick total`
			);
			// null (présent), PAS undefined (clé supprimée) — parité avec Postgres.
			expect(check.rows[0]?.total).toBeNull();
		} finally {
			await wipe(conn);
			await conn.close();
		}
	}, 20_000);

	it("_id 24-hex fourni à l'insert est adressable par un filtre `_id` (round-trip cohérent)", async () => {
		const conn = await mongoAdapter.connect(loadConfig());
		const hex = "507f1f77bcf86cd799439011";
		try {
			await wipe(conn);
			await runQuery(conn, `add {_id: "${hex}", sku: "keep"} into ${PROBE}`);
			await runQuery(conn, `add {sku: "other"} into ${PROBE}`);

			// Insert et filtre coercent tous deux la chaîne 24-hex → ObjectId : le
			// document est retrouvé (sinon il serait « inadressable » par son _id).
			const found = await runQuery(
				conn,
				`get ${PROBE} | where _id = "${hex}" | pick sku`
			);
			expect(found.rows.map((r) => r.sku)).toEqual(["keep"]);
		} finally {
			await wipe(conn);
			await conn.close();
		}
	}, 20_000);

	it("décimal écrit exactement (Decimal128, pas de double lossy)", async () => {
		const conn = await mongoAdapter.connect(loadConfig());
		try {
			await wipe(conn);
			await runQuery(
				conn,
				`add {sku: "dec", price: 1.123456789012345678} into ${PROBE}`
			);
			const check = await runQuery(
				conn,
				`get ${PROBE} | where sku = "dec" | pick price`
			);
			// normalizeBson rend un Decimal128 en chaîne décimale exacte.
			expect(check.rows[0]?.price).toBe("1.123456789012345678");
		} finally {
			await wipe(conn);
			await conn.close();
		}
	}, 20_000);
});
