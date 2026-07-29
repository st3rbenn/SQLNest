import { describe, expect, it } from "vitest";
import { buildSchemaModel, mapPgType } from "./introspect";

describe("mapPgType", () => {
	it("mappe les types Postgres courants → SnqlType", () => {
		expect(mapPgType("bigint")).toBe("bigint");
		expect(mapPgType("integer")).toBe("int");
		expect(mapPgType("smallint")).toBe("int");
		expect(mapPgType("text")).toBe("string");
		expect(mapPgType("character varying")).toBe("string");
		expect(mapPgType("boolean")).toBe("bool");
		expect(mapPgType("numeric")).toBe("decimal");
		expect(mapPgType("double precision")).toBe("float");
		expect(mapPgType("timestamp with time zone")).toBe("date");
		expect(mapPgType("jsonb")).toBe("json");
		expect(mapPgType("uuid")).toBe("uuid");
		expect(mapPgType("ARRAY")).toBe("array");
		expect(mapPgType("un_type_inconnu")).toBe("unknown");
	});
});

describe("buildSchemaModel", () => {
	it("assemble collections, champs typés, PK et relations FK", () => {
		const model = buildSchemaModel(
			["orders", "users"],
			[
				{
					table_name: "users",
					column_name: "id",
					data_type: "bigint",
					is_nullable: "NO"
				},
				{
					table_name: "users",
					column_name: "email",
					data_type: "text",
					is_nullable: "NO"
				},
				{
					table_name: "users",
					column_name: "display_name",
					data_type: "text",
					is_nullable: "YES"
				},
				{
					table_name: "orders",
					column_name: "id",
					data_type: "bigint",
					is_nullable: "NO"
				},
				{
					table_name: "orders",
					column_name: "user_id",
					data_type: "bigint",
					is_nullable: "NO"
				}
			],
			[
				{ table_name: "users", column_name: "id" },
				{ table_name: "orders", column_name: "id" }
			],
			[
				{
					constraint_oid: "16400",
					from_table: "orders",
					from_column: "user_id",
					to_table: "users",
					to_column: "id"
				}
			]
		);

		expect(model.engine).toBe("postgres");
		expect(model.collections.map((c) => c.name)).toEqual(["orders", "users"]);

		const users = model.collections.find((c) => c.name === "users");
		expect(users?.source).toBe("declared");
		expect(users?.primaryKey).toEqual(["id"]);
		expect(users?.fields.find((f) => f.name === "email")).toEqual({
			name: "email",
			type: "string",
			nullable: false,
			source: "declared"
		});
		expect(users?.fields.find((f) => f.name === "display_name")?.nullable).toBe(
			true
		);

		expect(model.relations).toEqual([
			{
				from: { collection: "orders", fields: ["user_id"] },
				to: { collection: "users", fields: ["id"] },
				kind: "many-to-one",
				origin: "foreign-key",
				confidence: 1
			}
		]);
	});

	it("omet primaryKey pour une table sans PK", () => {
		const model = buildSchemaModel(
			["logs"],
			[
				{
					table_name: "logs",
					column_name: "msg",
					data_type: "text",
					is_nullable: "YES"
				}
			],
			[],
			[]
		);
		expect(model.collections[0]?.primaryKey).toBeUndefined();
	});

	it("FK composite : colonnes alignées dans l'ordre", () => {
		const model = buildSchemaModel(
			["a", "b"],
			[],
			[],
			[
				{
					constraint_oid: "20000",
					from_table: "a",
					from_column: "x1",
					to_table: "b",
					to_column: "y1"
				},
				{
					constraint_oid: "20000",
					from_table: "a",
					from_column: "x2",
					to_table: "b",
					to_column: "y2"
				}
			]
		);
		expect(model.relations).toHaveLength(1);
		expect(model.relations[0]?.from.fields).toEqual(["x1", "x2"]);
		expect(model.relations[0]?.to.fields).toEqual(["y1", "y2"]);
	});

	it("FK homonymes de tables différentes → relations distinctes (OID)", () => {
		// Deux FK au même nom (légal : unique par table, pas par schéma) mais OID
		// différents ne doivent PAS fusionner.
		const model = buildSchemaModel(
			["orders", "invoices"],
			[],
			[],
			[
				{
					constraint_oid: "30001",
					from_table: "orders",
					from_column: "user_id",
					to_table: "users",
					to_column: "id"
				},
				{
					constraint_oid: "30002",
					from_table: "invoices",
					from_column: "customer_id",
					to_table: "customers",
					to_column: "id"
				}
			]
		);
		expect(model.relations).toHaveLength(2);
		expect(model.relations.map((r) => r.from.collection).sort()).toEqual([
			"invoices",
			"orders"
		]);
	});
});
