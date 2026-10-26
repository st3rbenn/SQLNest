/**
 * `uuid` et `decimal` rangés en texte sous le profil prisma (ADR-036 D6), et
 * FK vers une clé ObjectId, sur un vrai MongoDB : DDL compilé avec le profil,
 * écritures de SNQL et écritures « à la Prisma Client » (texte), lectures
 * numériques d'un décimal en texte. Base `e2g_text`, supprimée ensuite.
 *
 * `SNQL_TEST_MONGO_URL=mongodb://localhost:27017/sqlnest_demo?directConnection=true`.
 */

import {
	getMapper,
	lowerDDL,
	MONGO_TEXT_PATTERN,
	parse,
	tokenize
} from "@sqlnest/snql";
import { type Document, MongoClient, ObjectId } from "mongodb";
import { describe, expect, it } from "vitest";
import type { Connection } from "../adapter";
import { connect, resolveMongoConfig } from "../index";
import { runQuery } from "../run";

const BASE_URL = process.env.SNQL_TEST_MONGO_URL ?? "";
const DATABASE = "e2g_text";

function isolated(url: string): string {
	if (url === "") return url;
	const u = new URL(url);
	u.pathname = `/${DATABASE}`;
	return u.toString();
}

const URL_ = isolated(BASE_URL);
const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** DDL compilé avec le profil prisma, comme la boucle du CLI (ADR-037 D3). */
async function ddl(conn: Connection, src: string): Promise<void> {
	const plan = lowerDDL(
		parse(tokenize(src)) as Parameters<typeof lowerDDL>[0],
		await conn.introspect(),
		{ ormProfile: "prisma" }
	);
	const native = getMapper("mongodb").mapDDL?.(plan);
	if (native === undefined) throw new Error("pas de DDL Mongo");
	await conn.execute(native);
}

describe.skipIf(BASE_URL === "")(
	"mongodb — uuid et decimal en texte sous le profil prisma (ADR-036 D6)",
	() => {
		it("validateur texte, écritures canoniques, lectures et écritures numériques", async () => {
			const conn = await connect(resolveMongoConfig({ url: URL_ }));
			const client = await MongoClient.connect(URL_);
			const db = client.db();
			// Avec le schéma, comme l'app : l'alias `id` y devient `_id`.
			const labels = async (query: string) =>
				(await runQuery(conn, query, await conn.introspect())).rows.map(
					(r) => r.label
				);
			try {
				await db.dropDatabase();
				await ddl(
					conn,
					"create table e2g_item { id: uuid default uuid(), price: decimal, code: uuid nullable, label: text, primary key (id) }"
				);
				const info = (
					await db.listCollections({ name: "e2g_item" }).toArray()
				)[0] as { options?: { validator?: Document } } | undefined;
				const properties = info?.options?.validator?.$jsonSchema?.properties as
					| Record<string, Document>
					| undefined;
				expect(properties?.price).toEqual({
					bsonType: "string",
					pattern: MONGO_TEXT_PATTERN.decimal
				});
				expect(properties?.code).toEqual({
					bsonType: ["string", "null"],
					pattern: MONGO_TEXT_PATTERN.uuid
				});

				// Introspection : le type SNQL reste, la représentation est relue.
				const item = (await conn.introspect()).collections.find(
					(c) => c.name === "e2g_item"
				);
				const field = (name: string) =>
					item?.fields.find((f) => f.name === name);
				expect(field("price")).toMatchObject({
					type: "decimal",
					storedAs: "string"
				});
				expect(field("code")).toMatchObject({
					type: "uuid",
					storedAs: "string"
				});

				// Écritures SNQL : texte canonique, uuid() en minuscules.
				const code = "5D3B1C2A-1111-4222-8333-944455556666";
				await runQuery(
					conn,
					`add [{price: 12.50, label: "a", code: "${code}"}, {price: 9.5, label: "b", code: null}, {price: 150, label: "c", code: null}] into e2g_item`
				);
				const stored = await db
					.collection("e2g_item")
					.find({}, { sort: { label: 1 } })
					.toArray();
				expect(stored.map((d) => d.price)).toEqual(["12.50", "9.5", "150"]);
				expect(stored[0]?.code).toBe(code.toLowerCase());
				expect(
					stored.every((d) => typeof d._id === "string" && UUID_RE.test(d._id))
				).toBe(true);

				// Écritures « à la Prisma Client » : du texte, contrôlé par le validateur.
				const pId = "0b9f2e1c-3d4a-4b5c-8d6e-7f8091a2b3c4";
				await db.collection("e2g_item").insertOne({
					_id: pId as unknown as ObjectId,
					price: "7.25",
					label: "p"
				});
				await expect(
					db.collection("e2g_item").insertOne({ price: "abc", label: "x" })
				).rejects.toThrow("Document failed validation");
				await expect(
					db.collection("e2g_item").insertOne({ price: 7.25, label: "y" })
				).rejects.toThrow("Document failed validation");

				// Lectures : comparées, triées et sommées sur la valeur.
				expect(
					await labels("find e2g_item where price > 10 pick label sort label")
				).toEqual(["a", "c"]);
				expect(
					await labels("find e2g_item where price = 12.5 pick label")
				).toEqual(["a"]);
				expect(await labels("find e2g_item pick label sort price")).toEqual([
					"p",
					"b",
					"a",
					"c"
				]);
				expect(
					(await runQuery(conn, "get e2g_item pick sum(price) as total")).rows
				).toEqual([{ total: "179.25" }]);
				expect(
					await labels(`find e2g_item where code = "${code}" pick label`)
				).toEqual(["a"]);
				expect(
					await labels(
						`find e2g_item where id = "${pId.toUpperCase()}" pick label`
					)
				).toEqual(["p"]);

				// Écritures filtrées et calculées : sur la valeur, rangées en texte.
				expect(
					(
						await runQuery(
							conn,
							"update e2g_item where price < 10 set price = price * 2"
						)
					).rowCount
				).toBe(2);
				expect(
					(await runQuery(conn, "remove from e2g_item where price >= 150"))
						.rowCount
				).toBe(1);
				const after = await db
					.collection("e2g_item")
					.find({}, { sort: { label: 1 } })
					.toArray();
				expect(after.map((d) => [d.label, d.price])).toEqual([
					["a", "12.50"],
					["b", "19.0"],
					["p", "14.50"]
				]);

				// add column et set type sous le profil : backfill et conversion en texte.
				await ddl(conn, "add column fee decimal default 1.5 into e2g_item");
				await ddl(conn, "add column qty text nullable into e2g_item");
				await runQuery(
					conn,
					'update e2g_item where label = "a" set qty = "3.0"'
				);
				await ddl(conn, "alter column e2g_item.qty set type decimal");
				const typed = await db
					.collection("e2g_item")
					.find({}, { sort: { label: 1 } })
					.toArray();
				expect(typed.map((d) => d.fee)).toEqual(["1.5", "1.5", "1.5"]);
				expect(typed[0]?.qty).toBe("3.0");
				expect(await labels("find e2g_item where qty = 3 pick label")).toEqual([
					"a"
				]);
			} finally {
				await db.dropDatabase();
				await client.close();
				await conn.close();
			}
		}, 60_000);

		it("FK vers une clé ObjectId (celle de Prisma) : rangée en ObjectId", async () => {
			const conn = await connect(resolveMongoConfig({ url: URL_ }));
			const client = await MongoClient.connect(URL_);
			const db = client.db();
			try {
				await db.dropDatabase();
				// Collection écrite par Prisma : clé ObjectId, pas de validateur.
				const owner = new ObjectId();
				await db.collection("e2g_owner").insertOne({ _id: owner, name: "ada" });
				const schema = await conn.introspect();
				expect(
					schema.collections
						.find((c) => c.name === "e2g_owner")
						?.fields.find((f) => f.name === "_id")?.storedAs
				).toBe("objectId");

				await ddl(
					conn,
					"create table e2g_pet { id: uuid default uuid(), owner_id: string ref e2g_owner._id, name: text, primary key (id) }"
				);
				await runQuery(
					conn,
					`add {owner_id: "${owner.toHexString()}", name: "rex"} into e2g_pet`
				);
				const pet = await db.collection("e2g_pet").findOne({});
				expect(pet?.owner_id).toBeInstanceOf(ObjectId);
				expect(
					(
						await runQuery(
							conn,
							`find e2g_pet where owner_id = "${owner.toHexString()}" pick name`
						)
					).rows
				).toEqual([{ name: "rex" }]);
				// Jointure native : ObjectId des deux côtés.
				const joined = await db
					.collection("e2g_pet")
					.aggregate([
						{
							$lookup: {
								from: "e2g_owner",
								localField: "owner_id",
								foreignField: "_id",
								as: "owner"
							}
						}
					])
					.toArray();
				expect((joined[0]?.owner as Document[])[0]?.name).toBe("ada");
			} finally {
				await db.dropDatabase();
				await client.close();
				await conn.close();
			}
		}, 60_000);
	}
);
