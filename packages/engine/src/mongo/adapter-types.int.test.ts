import { type Document, MongoClient, UUID } from "mongodb";
import { describe, expect, it } from "vitest";
import { runQuery } from "../run";
import { mongoAdapter } from "./adapter";
import { resolveMongoConfig } from "./config";

/**
 * Valeurs écrites au type déclaré de leur colonne (ADR-029 D15), sur un vrai
 * MongoDB : `SNQL_TEST_MONGO_URL=mongodb://localhost:27017/sqlnest_demo?directConnection=true`.
 * Sans cette variable, tout le bloc est sauté. Tables `e2w_*`, supprimées ensuite.
 */
const MONGO_URL = process.env.SNQL_TEST_MONGO_URL ?? "";
const hasMongo = MONGO_URL !== "";
const loadConfig = () => resolveMongoConfig({ url: MONGO_URL });
const U1 = "6f1c2b9e-1b2a-4c3d-8e9f-0a1b2c3d4e5f";
const U2 = "0f8fad5b-d9cb-469f-a165-70867728950e";

/** Type BSON stocké de chaque champ présent, document par document. */
async function storedTypes(
	collection: string,
	fields: readonly string[],
	sortBy = "_id"
): Promise<Document[]> {
	const client = await MongoClient.connect(MONGO_URL);
	try {
		const project: Document = { _id: 0 };
		for (const f of fields) project[f] = { $type: `$${f}` };
		const docs = await client
			.db()
			.collection(collection)
			.aggregate([{ $sort: { [sortBy]: 1 } }, { $project: project }])
			.toArray();
		return docs.map((doc) =>
			Object.fromEntries(Object.entries(doc).filter(([, t]) => t !== "missing"))
		);
	} finally {
		await client.close();
	}
}

/** Documents bruts, valeurs BSON telles que le driver les rend. */
async function rawDocs(collection: string): Promise<Document[]> {
	const client = await MongoClient.connect(MONGO_URL);
	try {
		return await client
			.db()
			.collection(collection)
			.find()
			.sort({ _id: 1 })
			.toArray();
	} finally {
		await client.close();
	}
}

describe.skipIf(!hasMongo)(
	"mongodb adapter — valeurs au type déclaré (ADR-029 D15)",
	() => {
		it("add : chaque valeur prend le type de sa colonne, se relit et se retrouve par filtre", async () => {
			const conn = await mongoAdapter.connect(loadConfig());
			try {
				await runQuery(conn, "drop table e2w_types if exists");
				await runQuery(
					conn,
					"create table e2w_types { id: int, f: float nullable, d: decimal nullable, b: bigint nullable, u: uuid nullable, at: timestamp nullable, n: int nullable, s: text nullable, ok: bool nullable, primary key (id) }"
				);
				for (const doc of [
					"{ id: 1, f: 1 }",
					"{ id: 2, f: 1.5 }",
					"{ id: 3, d: 2 }",
					"{ id: 4, d: 2.25 }",
					"{ id: 5, b: 5 }",
					`{ id: 6, u: "${U1}" }`,
					"{ id: 7, b: 9007199254740993 }",
					'{ id: 8, at: "2024-03-01T10:00:00Z" }',
					'{ id: 9, n: 2.0, s: 42, ok: "yes" }'
				]) {
					await runQuery(conn, `add ${doc} into e2w_types`);
				}

				expect(
					await storedTypes("e2w_types", [
						"f",
						"d",
						"b",
						"u",
						"at",
						"n",
						"s",
						"ok"
					])
				).toEqual([
					{ f: "double" },
					{ f: "double" },
					{ d: "decimal" },
					{ d: "decimal" },
					{ b: "long" },
					{ u: "binData" },
					{ b: "long" },
					{ at: "date" },
					{ n: "int", s: "string", ok: "bool" }
				]);
				const raw = await rawDocs("e2w_types");
				expect(raw[5]?.u).toBeInstanceOf(UUID);

				// Le schéma porte l'alias `id` ↔ `_id`, comme côté CLI.
				const schema = await conn.introspect();
				const read = await runQuery(
					conn,
					"find e2w_types pick id, f, d, b, u, at, n, s, ok sort id",
					schema
				);
				expect(read.rows).toEqual([
					{ id: 1, f: 1 },
					{ id: 2, f: 1.5 },
					{ id: 3, d: "2" },
					{ id: 4, d: "2.25" },
					{ id: 5, b: 5 },
					{ id: 6, u: U1 },
					{ id: 7, b: 9007199254740993n },
					{ id: 8, at: new Date("2024-03-01T10:00:00Z") },
					{ id: 9, n: 2, s: "42", ok: true }
				]);

				const ids = async (where: string) =>
					(
						await runQuery(
							conn,
							`find e2w_types where ${where} pick id sort id`,
							schema
						)
					).rows;
				expect(await ids(`u = "${U1}"`)).toEqual([{ id: 6 }]);
				expect(await ids(`u = "${U1.toUpperCase()}"`)).toEqual([{ id: 6 }]);
				expect(await ids(`u in ["${U2}", "${U1}"]`)).toEqual([{ id: 6 }]);
				expect(await ids(`u != "${U1}"`)).toEqual([]);
				expect(await ids("d = 2.25")).toEqual([{ id: 4 }]);
				expect(await ids("d = 2")).toEqual([{ id: 3 }]);
				expect(await ids("b = 5")).toEqual([{ id: 5 }]);
				expect(await ids("f = 1.5")).toEqual([{ id: 2 }]);

				// Refus nommés, rien n'est écrit.
				await expect(
					runQuery(conn, "add { id: 10, b: 1.5 } into e2w_types")
				).rejects.toThrow(
					"insert dans 'e2w_types' : 'b' (bigint) n'accepte pas 1.5 — valeur non entière"
				);
				await expect(
					runQuery(conn, 'add { id: 10, u: "abc" } into e2w_types')
				).rejects.toThrow(
					`insert dans 'e2w_types' : 'u' (uuid) n'accepte pas "abc"`
				);
				await expect(
					runQuery(conn, 'add { id: 10, at: "hier" } into e2w_types')
				).rejects.toThrow(
					`insert dans 'e2w_types' : 'at' (date) n'accepte pas "hier"`
				);
				await expect(
					runQuery(conn, "add { id: 10, n: 3000000000 } into e2w_types")
				).rejects.toThrow(
					"insert dans 'e2w_types' : 'n' (int) n'accepte pas 3000000000 — hors plage"
				);
				await expect(
					runQuery(conn, 'add { id: 10, ok: "peut-être" } into e2w_types')
				).rejects.toThrow(
					`insert dans 'e2w_types' : 'ok' (bool) n'accepte pas "peut-être"`
				);
				expect((await runQuery(conn, "find e2w_types pick id")).rowCount).toBe(
					9
				);
			} finally {
				await runQuery(conn, "drop table e2w_types if exists");
				await conn.close();
			}
		}, 60_000);

		it("update, upsert et forme pipeline : valeurs littérales et calculées converties", async () => {
			const conn = await mongoAdapter.connect(loadConfig());
			try {
				await runQuery(conn, "drop table e2w_upd if exists");
				await runQuery(
					conn,
					"create table e2w_upd { code: text, n: int nullable, f: float nullable, d: decimal nullable, b: bigint nullable, u: uuid nullable, s: text nullable }"
				);
				await runQuery(
					conn,
					'add [{ code: "a", n: 3 }, { code: "b", n: 4 }] into e2w_upd'
				);

				await runQuery(
					conn,
					`update e2w_upd where code = "a" set f = 2, d = 3, b = 4, u = "${U1}"`
				);
				// Forme pipeline : la valeur vient d'un autre champ (int → float, decimal, bigint, texte).
				await runQuery(
					conn,
					'update e2w_upd where code = "b" set f = n, d = n, b = n, s = n'
				);
				// Upsert : clé typée, branche insert et branche edit.
				await runQuery(
					conn,
					`add { code: "c", b: 7, u: "${U2}" } into e2w_upd on conflict (b) edit set f = 8`
				);
				await runQuery(
					conn,
					`add { code: "c2", b: 7, u: "${U2}" } into e2w_upd on conflict (b) edit set f = 9, d = 9`
				);
				await runQuery(
					conn,
					`update e2w_upd where u = "${U1}" set s = "par uuid"`
				);

				// Tri par `code` : l'upsert reçoit un `_id` généré par le serveur.
				expect(
					await storedTypes(
						"e2w_upd",
						["code", "f", "d", "b", "u", "s"],
						"code"
					)
				).toEqual([
					expect.objectContaining({
						code: "string",
						f: "double",
						d: "decimal",
						b: "long",
						u: "binData",
						s: "string"
					}),
					expect.objectContaining({
						code: "string",
						f: "double",
						d: "decimal",
						b: "long",
						s: "string"
					}),
					expect.objectContaining({
						code: "string",
						f: "double",
						d: "decimal",
						b: "long",
						u: "binData"
					})
				]);
				const rows = (
					await runQuery(
						conn,
						"find e2w_upd pick code, n, f, d, b, u, s sort code"
					)
				).rows;
				expect(rows).toEqual([
					{ code: "a", n: 3, f: 2, d: "3", b: 4, u: U1, s: "par uuid" },
					{ code: "b", n: 4, f: 4, d: "4", b: 4, s: "4" },
					{ code: "c", f: 9, d: "9", b: 7, u: U2 }
				]);
			} finally {
				await runQuery(conn, "drop table e2w_upd if exists");
				await conn.close();
			}
		}, 60_000);

		it("insert-select, transaction et savepoint : documents convertis avant l'écriture", async () => {
			const conn = await mongoAdapter.connect(loadConfig());
			const drop = async () => {
				for (const t of ["e2w_src", "e2w_dst"]) {
					await runQuery(conn, `drop table ${t} if exists`);
				}
			};
			try {
				await drop();
				await runQuery(
					conn,
					"create table e2w_src { n: int, s: text nullable }"
				);
				await runQuery(
					conn,
					'create table e2w_dst { f: float, d: decimal, b: bigint, u: uuid nullable, tag: text default "copie" }'
				);
				await runQuery(
					conn,
					`add [{ n: 1, s: "${U1}" }, { n: 2, s: null }, { n: 5, s: null }] into e2w_src`
				);

				const copied = await runQuery(
					conn,
					"add (find e2w_src where n < 5 pick n as f, n as d, n as b, s as u) into e2w_dst"
				);
				expect(copied.rowCount).toBe(2);
				await runQuery(
					conn,
					"transaction { add { f: 3, d: 3, b: 3 } into e2w_dst; update e2w_dst where b = 3 set d = 30 }"
				);
				await runQuery(
					conn,
					'transaction { savepoint s1 { add { f: 4, d: 4, b: 4, u: "' +
						U2 +
						'" } into e2w_dst } }'
				);
				await runQuery(
					conn,
					"transaction { add (find e2w_src where n = 5 pick n as f, n as d, n as b) into e2w_dst }"
				);

				const types = await storedTypes("e2w_dst", ["f", "d", "b", "u", "tag"]);
				for (const t of types) {
					expect(t).toMatchObject({
						f: "double",
						d: "decimal",
						b: "long",
						tag: "string"
					});
				}
				const rows = (
					await runQuery(conn, "find e2w_dst pick f, d, b, u, tag sort b, f")
				).rows;
				expect(rows).toEqual([
					{ f: 1, d: "1", b: 1, u: U1, tag: "copie" },
					{ f: 2, d: "2", b: 2, u: null, tag: "copie" },
					{ f: 3, d: "30", b: 3, tag: "copie" },
					{ f: 4, d: "4", b: 4, u: U2, tag: "copie" },
					{ f: 5, d: "5", b: 5, tag: "copie" }
				]);
			} finally {
				await drop();
				await conn.close();
			}
		}, 60_000);

		it("alter column set type, défauts et remplissage d'add column : au type de la colonne", async () => {
			const conn = await mongoAdapter.connect(loadConfig());
			try {
				await runQuery(conn, "drop table e2w_alt if exists");
				await runQuery(
					conn,
					"create table e2w_alt { code: text, c: int nullable, b: bigint default 5, f: float default 1, d: decimal default 2 }"
				);
				await runQuery(conn, 'add { code: "a", c: 1 } into e2w_alt');

				await runQuery(conn, "alter column e2w_alt.c set type bigint");
				await runQuery(conn, 'add { code: "b", c: 2 } into e2w_alt');
				await runQuery(conn, "alter column e2w_alt.b set default 9");
				await runQuery(conn, 'add { code: "c" } into e2w_alt');
				await runQuery(conn, "add column g bigint default 7 into e2w_alt");
				await runQuery(conn, "add column h uuid nullable into e2w_alt");
				await runQuery(conn, "alter column e2w_alt.h set default uuid()");
				await runQuery(conn, 'add { code: "d" } into e2w_alt');

				expect(
					await storedTypes("e2w_alt", ["c", "b", "f", "d", "g", "h"], "code")
				).toEqual([
					expect.objectContaining({
						c: "long",
						b: "long",
						f: "double",
						d: "decimal",
						g: "long"
					}),
					expect.objectContaining({
						c: "long",
						b: "long",
						f: "double",
						d: "decimal",
						g: "long"
					}),
					expect.objectContaining({
						b: "long",
						f: "double",
						d: "decimal",
						g: "long"
					}),
					expect.objectContaining({
						b: "long",
						f: "double",
						d: "decimal",
						g: "long",
						h: "binData"
					})
				]);
				expect(
					(
						await runQuery(
							conn,
							"find e2w_alt pick code, c, b, f, d, g sort code"
						)
					).rows
				).toEqual([
					{ code: "a", c: 1, b: 5, f: 1, d: "2", g: 7 },
					{ code: "b", c: 2, b: 5, f: 1, d: "2", g: 7 },
					{ code: "c", b: 9, f: 1, d: "2", g: 7 },
					{ code: "d", b: 9, f: 1, d: "2", g: 7 }
				]);
			} finally {
				await runQuery(conn, "drop table e2w_alt if exists");
				await conn.close();
			}
		}, 60_000);
	}
);
