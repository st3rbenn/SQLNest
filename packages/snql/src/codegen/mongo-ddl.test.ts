import { describe, expect, it } from "vitest";
import type { CreateTablePlan, DDLPlan } from "../ir/plan";
import type { MongoDDLQuery } from "./mapper";
import { mongoMapper } from "./mongodb";

function mapDDL(plan: DDLPlan): MongoDDLQuery {
	if (mongoMapper.mapDDL === undefined) {
		throw new Error("mongoMapper.mapDDL manquant");
	}
	const q = mongoMapper.mapDDL(plan);
	if (q.kind !== "mongo-ddl") throw new Error(`attendu mongo-ddl, got ${q.kind}`);
	return q;
}

describe("codegen Mongo — create table (ADR-029 DDL/1.6)", () => {
	it("émet MongoDDLQuery avec validator $jsonSchema minimal", () => {
		const q = mapDDL({
			op: "ddl",
			kind: "create-table",
			target: "users",
			ifNotExists: false,
			fields: [
				{ name: "email", type: "string", nullable: false, unique: false }
			]
		});
		expect(q).toMatchObject({
			engine: "mongodb",
			kind: "mongo-ddl",
			operation: "create-collection",
			collection: "users",
			ifNotExists: false,
			validator: {
				$jsonSchema: {
					bsonType: "object",
					properties: { email: { bsonType: "string" } },
					required: ["email"]
				}
			}
		});
		expect(q.indexes).toBeUndefined();
		expect(q.primaryKeyAlias).toBeUndefined();
	});

	it("map SnqlType → MONGO_BSON_TYPE (D1)", () => {
		const q = mapDDL({
			op: "ddl",
			kind: "create-table",
			target: "matrix",
			ifNotExists: false,
			fields: [
				{ name: "s", type: "string", nullable: true, unique: false },
				{ name: "i", type: "int", nullable: true, unique: false },
				{ name: "bi", type: "bigint", nullable: true, unique: false },
				{ name: "f", type: "float", nullable: true, unique: false },
				{ name: "d", type: "decimal", nullable: true, unique: false },
				{ name: "b", type: "bool", nullable: true, unique: false },
				{ name: "dt", type: "date", nullable: true, unique: false },
				{ name: "j", type: "json", nullable: true, unique: false },
				{ name: "a", type: "array", nullable: true, unique: false },
				{ name: "u", type: "uuid", nullable: true, unique: false },
				{ name: "e", type: "enum", nullable: true, unique: false },
				{ name: "un", type: "unknown", nullable: true, unique: false }
			]
		});
		const props = (
			(q.validator as { $jsonSchema: { properties: Record<string, { bsonType?: string }> } })
				.$jsonSchema.properties
		);
		expect(props.s?.bsonType).toBe("string");
		expect(props.i?.bsonType).toBe("int");
		expect(props.bi?.bsonType).toBe("long");
		expect(props.f?.bsonType).toBe("double");
		expect(props.d?.bsonType).toBe("decimal");
		expect(props.b?.bsonType).toBe("bool");
		expect(props.dt?.bsonType).toBe("date");
		expect(props.j?.bsonType).toBe("object");
		expect(props.a?.bsonType).toBe("array");
		expect(props.u?.bsonType).toBe("binData");
		expect(props.e?.bsonType).toBe("string");
		expect(props.un?.bsonType).toBeUndefined(); // unknown → pas de contrainte
	});

	it("D13 : primary key (id) single-field UUID → alias _id, id skip du validator", () => {
		const q = mapDDL({
			op: "ddl",
			kind: "create-table",
			target: "users",
			ifNotExists: false,
			fields: [
				{ name: "id", type: "uuid", nullable: false, unique: false },
				{ name: "email", type: "string", nullable: false, unique: false }
			],
			primaryKey: ["id"]
		});
		expect(q.primaryKeyAlias).toBe("id");
		const schema = q.validator as { $jsonSchema: { properties: Record<string, unknown>; required: string[] } };
		expect(schema.$jsonSchema.properties).not.toHaveProperty("id");
		expect(schema.$jsonSchema.properties).toHaveProperty("email");
		expect(schema.$jsonSchema.required).toEqual(["email"]);
		expect(q.indexes).toBeUndefined();
	});

	it("D13 : primary key compound (a, b) → createIndex unique pk_a_b", () => {
		const q = mapDDL({
			op: "ddl",
			kind: "create-table",
			target: "pairs",
			ifNotExists: false,
			fields: [
				{ name: "a", type: "uuid", nullable: false, unique: false },
				{ name: "b", type: "uuid", nullable: false, unique: false }
			],
			primaryKey: ["a", "b"]
		});
		expect(q.primaryKeyAlias).toBeUndefined();
		expect(q.indexes).toEqual([
			{ keys: { a: 1, b: 1 }, options: { unique: true, name: "pk_a_b" } }
		]);
	});

	it("D13 refus sémantique : primary key single sur field ≠ 'id' → codegen_mongo_primary_key_not_id", () => {
		expect(() =>
			mapDDL({
				op: "ddl",
				kind: "create-table",
				target: "users",
				ifNotExists: false,
				fields: [
					{ name: "email", type: "string", nullable: false, unique: false }
				],
				primaryKey: ["email"]
			})
		).toThrow(/PK unique|add unique index/);
	});

	it("field unique → createIndex secondaire (skip si aliasé _id)", () => {
		const q = mapDDL({
			op: "ddl",
			kind: "create-table",
			target: "users",
			ifNotExists: false,
			fields: [
				{ name: "id", type: "uuid", nullable: false, unique: true },
				{ name: "email", type: "string", nullable: false, unique: true }
			],
			primaryKey: ["id"]
		});
		expect(q.primaryKeyAlias).toBe("id");
		expect(q.indexes).toEqual([
			{ keys: { email: 1 }, options: { unique: true, name: "unique_email" } }
		]);
	});

	it("ifNotExists=true propagé (D3 adapter catch NamespaceExists 48)", () => {
		const q = mapDDL({
			op: "ddl",
			kind: "create-table",
			target: "sessions",
			ifNotExists: true,
			fields: [
				{ name: "token", type: "string", nullable: false, unique: false }
			]
		});
		expect(q.ifNotExists).toBe(true);
	});
});
