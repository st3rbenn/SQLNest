import { describe, expect, it } from "vitest";
import {
	applyPkAlias,
	inferCollection,
	inferRelations,
	linkEnumColumns,
	mergeValidatorFields,
	snqlTypeOf
} from "./introspect";

describe("snqlTypeOf", () => {
	it("mappe les types JS/BSON vers SnqlType", () => {
		expect(snqlTypeOf("x")).toBe("string");
		expect(snqlTypeOf(true)).toBe("bool");
		expect(snqlTypeOf(42)).toBe("int");
		expect(snqlTypeOf(3.14)).toBe("float");
		expect(snqlTypeOf(new Date())).toBe("date");
		expect(snqlTypeOf([1, 2])).toBe("array");
		expect(snqlTypeOf({ a: 1 })).toBe("json");
		expect(snqlTypeOf({ _bsontype: "ObjectId" })).toBe("string");
		expect(snqlTypeOf({ _bsontype: "Decimal128" })).toBe("decimal");
		expect(snqlTypeOf({ _bsontype: "Long" })).toBe("bigint");
		expect(snqlTypeOf(null)).toBe("unknown");
	});
});

describe("inferCollection (sampling)", () => {
	it("infère champs, types, nullable et confidence", () => {
		const col = inferCollection("users", [
			{ _id: 1, email: "a@b.c", active: true },
			{ _id: 2, email: "d@e.f", active: false },
			{ _id: 3, email: "g@h.i" } // `active` absent
		]);
		expect(col.source).toBe("inferred");
		expect(col.primaryKey).toEqual(["_id"]);

		const email = col.fields.find((f) => f.name === "email");
		expect(email?.type).toBe("string");
		expect(email?.confidence).toBe(1);
		expect(email?.nullable).toBe(false);

		const active = col.fields.find((f) => f.name === "active");
		expect(active?.type).toBe("bool");
		expect(active?.nullable).toBe(true); // absent d'un document
		expect(active?.confidence).toBeCloseTo(2 / 3);
	});

	it("un champ parfois null est nullable", () => {
		const col = inferCollection("t", [
			{ _id: 1, x: 5 },
			{ _id: 2, x: null }
		]);
		expect(col.fields.find((f) => f.name === "x")?.nullable).toBe(true);
	});

	it("collection sans _id : pas de primaryKey", () => {
		const col = inferCollection("logs", [{ msg: "x" }]);
		expect(col.primaryKey).toBeUndefined();
	});
});

describe("inferRelations (heuristique de nommage)", () => {
	it("<x>_id → collection <x>s si elle existe", () => {
		const users = inferCollection("users", [{ _id: 1 }]);
		const orders = inferCollection("orders", [{ _id: 1, user_id: 1 }]);
		expect(inferRelations([users, orders])).toEqual([
			{
				from: { collection: "orders", fields: ["user_id"] },
				to: { collection: "users", fields: ["_id"] },
				kind: "many-to-one",
				origin: "naming-heuristic",
				confidence: 0.6
			}
		]);
	});

	it("gère les pluriels irréguliers (category_id → categories)", () => {
		const products = inferCollection("products", [{ _id: 1, category_id: 5 }]);
		const categories = inferCollection("categories", [{ _id: 1 }]);
		const rels = inferRelations([products, categories]);
		expect(rels).toHaveLength(1);
		expect(rels[0]?.to.collection).toBe("categories");
	});

	it("gère le pluriel -es (address_id → addresses)", () => {
		const users = inferCollection("users", [{ _id: 1, address_id: 5 }]);
		const addresses = inferCollection("addresses", [{ _id: 1 }]);
		expect(inferRelations([users, addresses])[0]?.to.collection).toBe(
			"addresses"
		);
	});

	it("aucune relation si la collection cible n'existe pas", () => {
		const orders = inferCollection("orders", [{ _id: 1, ghost_id: 9 }]);
		expect(inferRelations([orders])).toEqual([]);
	});

	it("ignore le champ _id lui-même", () => {
		const items = inferCollection("items", [{ _id: 1 }]);
		expect(inferRelations([items])).toEqual([]);
	});
});

describe("mergeValidatorFields (ADR-031 — colonnes déclarées du validator)", () => {
	const emptyCol = { name: "orders", fields: [], source: "inferred" as const };

	it("ajoute les colonnes déclarées d'une collection vide (sampling 0 doc)", () => {
		const merged = mergeValidatorFields(emptyCol, {
			$jsonSchema: {
				bsonType: "object",
				properties: {
					id: { bsonType: "binData" },
					user_id: { bsonType: "binData" },
					total: { bsonType: "decimal" }
				},
				required: ["id", "user_id"]
			}
		});
		expect(merged.fields).toEqual([
			{ name: "id", type: "uuid", nullable: false, source: "declared" },
			{ name: "user_id", type: "uuid", nullable: false, source: "declared" },
			{ name: "total", type: "decimal", nullable: true, source: "declared" }
		]);
	});

	it("ne double pas une colonne déjà inférée par sampling", () => {
		const sampled = {
			name: "orders",
			fields: [
				{ name: "id", type: "uuid" as const, nullable: false, source: "inferred" as const, confidence: 1 }
			],
			source: "inferred" as const
		};
		const merged = mergeValidatorFields(sampled, {
			$jsonSchema: {
				bsonType: "object",
				properties: { id: { bsonType: "binData" }, note: { bsonType: "string" } }
			}
		});
		expect(merged.fields.map((f) => f.name)).toEqual(["id", "note"]);
		// `id` garde sa source inférée (sampling), pas écrasée.
		expect(merged.fields[0]?.source).toBe("inferred");
	});

	it("pass-through si pas de validator", () => {
		expect(mergeValidatorFields(emptyCol, undefined)).toBe(emptyCol);
	});

	it("bsonType inconnu → unknown", () => {
		const merged = mergeValidatorFields(emptyCol, {
			$jsonSchema: { properties: { weird: { bsonType: "javascript" } } }
		});
		expect(merged.fields[0]).toMatchObject({ name: "weird", type: "unknown" });
	});
});

describe("applyPkAlias (ADR-036 E/1f)", () => {
	it("présente `_id` sous son alias : champ SNQL, nom natif, clé primaire", () => {
		const collection = applyPkAlias(
			inferCollection("seat", [{ _id: 1, label: "a", id: "vestige" }]),
			{ column: "id", type: "int" }
		);
		expect(collection.primaryKey).toEqual(["id"]);
		expect(collection.fields[0]).toEqual({
			name: "id",
			type: "int",
			nullable: false,
			source: "declared",
			nativeName: "_id"
		});
		expect(collection.fields.map((f) => f.name)).toEqual(["id", "label"]);
	});

	it("sans alias, la collection ne change pas ; les relations visent l'alias", () => {
		const plain = inferCollection("seat", [{ _id: 1 }]);
		expect(applyPkAlias(plain, undefined)).toBe(plain);
		const seat = applyPkAlias(inferCollection("seat", [{ _id: 1 }]), {
			column: "id",
			type: "int"
		});
		const ticket = inferCollection("tickets", [{ _id: 1, seat_id: 1 }]);
		expect(inferRelations([seat, ticket])[0]?.to).toEqual({
			collection: "seat",
			fields: ["id"]
		});
	});
});

describe("linkEnumColumns (E/2c)", () => {
	it("colonne aux valeurs d'un enum : type enum et nom ; valeurs différentes : inchangée", () => {
		const [linked] = linkEnumColumns(
			[
				{
					name: "agency",
					source: "declared",
					fields: [
						{
							name: "tier",
							type: "string",
							nullable: true,
							source: "declared",
							enumValues: ["free", "pro"]
						},
						{
							name: "other",
							type: "string",
							nullable: true,
							source: "declared",
							enumValues: ["pro", "free"]
						}
					]
				}
			],
			[{ name: "tier", members: ["free", "pro"], source: "declared" }]
		);
		expect(linked?.fields[0]).toMatchObject({
			type: "enum",
			enumTypeName: "tier"
		});
		expect(linked?.fields[1]).toMatchObject({ type: "string" });
		expect(linked?.fields[1]).not.toHaveProperty("enumTypeName");
	});
});
