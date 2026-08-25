import { describe, expect, it } from "vitest";
import type { CreateTablePlan } from "../ir/plan";
import { mapKvDDL } from "./kv-ddl";

describe("codegen KV — create table (ADR-029 DDL/1.7)", () => {
	it("émet KvDDLQuery minimal avec fields descriptors", () => {
		const q = mapKvDDL({
			op: "ddl",
			kind: "create-table",
			target: "users",
			ifNotExists: false,
			fields: [
				{ name: "email", type: "string", nullable: false, unique: false }
			]
		});
		expect(q).toEqual({
			engine: "kv",
			kind: "kv-ddl",
			operation: "create-table",
			collection: "users",
			ifNotExists: false,
			fields: [
				{ name: "email", type: "string", nullable: false, unique: false }
			]
		});
	});

	it("map SnqlType 1:1 (D1 round-trip identity — pas de coercion)", () => {
		const q = mapKvDDL({
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
		expect(q.fields.map((f) => f.type)).toEqual([
			"string",
			"int",
			"bigint",
			"float",
			"decimal",
			"bool",
			"date",
			"json",
			"array",
			"uuid",
			"enum",
			"unknown"
		]);
	});

	it("D13 : primary key single (id) propagé tel quel (jamais refus)", () => {
		const q = mapKvDDL({
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
		expect(q.primaryKey).toEqual(["id"]);
	});

	it("D13 : primary key compound propagé tel quel (jamais refus)", () => {
		const q = mapKvDDL({
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
		expect(q.primaryKey).toEqual(["a", "b"]);
	});

	it("D13 : primary key sur field ≠ 'id' propagé (compensation runtime, PAS refus)", () => {
		// C'est le fix qui prouve la doctrine : sur Mongo c'est refus sémantique,
		// sur KV c'est compensation. Aucun refus « engine gap » sur KV.
		const q = mapKvDDL({
			op: "ddl",
			kind: "create-table",
			target: "users",
			ifNotExists: false,
			fields: [
				{ name: "email", type: "string", nullable: false, unique: false }
			],
			primaryKey: ["email"]
		});
		expect(q.primaryKey).toEqual(["email"]);
	});

	it("uniqueFields extrait de fields.unique=true", () => {
		const q = mapKvDDL({
			op: "ddl",
			kind: "create-table",
			target: "users",
			ifNotExists: false,
			fields: [
				{ name: "id", type: "uuid", nullable: false, unique: false },
				{ name: "email", type: "string", nullable: false, unique: true },
				{ name: "handle", type: "string", nullable: false, unique: true }
			]
		});
		expect(q.uniqueFields).toEqual(["email", "handle"]);
	});

	it("bigint / decimal defaults sérialisés lossless (D1)", () => {
		const q = mapKvDDL({
			op: "ddl",
			kind: "create-table",
			target: "t",
			ifNotExists: false,
			fields: [
				{
					name: "big",
					type: "bigint",
					nullable: false,
					unique: false,
					defaultValue: 9007199254740993n
				},
				{
					name: "price",
					type: "decimal",
					nullable: false,
					unique: false,
					defaultValue: { kind: "decimal", raw: "3.1415926535" }
				}
			]
		});
		expect(q.fields[0]?.defaultValue).toBe("9007199254740993");
		expect(q.fields[1]?.defaultValue).toBe("3.1415926535");
	});

	it("ifNotExists propagé (D3 : adapter existence-check `_schema` hash)", () => {
		const q = mapKvDDL({
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
