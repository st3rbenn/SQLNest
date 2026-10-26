import { Decimal128, Double, Long, UUID } from "mongodb";
import { describe, expect, it } from "vitest";
import { pipelineWithUuidForms, withUuidForms } from "./adapter";
import {
	convertValue,
	declaredPipeline,
	declaredTypeExpr,
	declaredTypes,
	declaredUpdate,
	toDeclaredType,
	toDeclaredTypes
} from "./declared-types";

const U1 = "6f1c2b9e-1b2a-4c3d-8e9f-0a1b2c3d4e5f";
const dec = (raw: string) => ({ kind: "decimal", raw });
const to = (value: unknown, bsonType: string) =>
	toDeclaredType(value, bsonType, "c", "insert dans 't'");
const refusal = (value: unknown, bsonType: string) => {
	try {
		to(value, bsonType);
	} catch (error) {
		return (error as Error).message;
	}
	return "accepté";
};

describe("declaredTypes — types du validateur", () => {
	it("null retiré d'une union, plusieurs types ignorés, sans validateur : aucun", () => {
		const types = declaredTypes({
			$jsonSchema: {
				bsonType: "object",
				properties: {
					f: { bsonType: ["double", "null"] },
					b: { bsonType: "long" },
					x: { bsonType: ["int", "string"] },
					free: {}
				}
			}
		});
		expect([...types]).toEqual([
			["f", "double"],
			["b", "long"]
		]);
		expect(declaredTypes(undefined).size).toBe(0);
	});
});

describe("toDeclaredType — valeur au type de sa colonne", () => {
	it("entiers : int reste un nombre, bigint devient Long ; non entier ou hors plage refusés", () => {
		expect(to(5, "int")).toBe(5);
		expect(to("7", "int")).toBe(7);
		expect(to(dec("2.0"), "int")).toBe(2);
		expect(to(dec("1e3"), "long")).toStrictEqual(Long.fromNumber(1000));
		expect(to(9007199254740993n, "long")).toStrictEqual(
			Long.fromBigInt(9007199254740993n)
		);
		expect(to(Decimal128.fromString("12"), "long")).toStrictEqual(
			Long.fromNumber(12)
		);
		expect(refusal(dec("1.5"), "long")).toBe(
			"insert dans 't' : 'c' (bigint) n'accepte pas 1.5 — valeur non entière"
		);
		expect(refusal(3000000000, "int")).toBe(
			"insert dans 't' : 'c' (int) n'accepte pas 3000000000 — hors plage"
		);
		expect(refusal("9223372036854775808", "long")).toMatch(/hors plage$/);
		expect(refusal(true, "int")).toBe(
			"insert dans 't' : 'c' (int) n'accepte pas true"
		);
	});

	it("float et decimal depuis un entier, un décimal exact, un bigint ou un texte numérique", () => {
		expect(to(1, "double")).toStrictEqual(new Double(1));
		expect(to(dec("1.5"), "double")).toStrictEqual(new Double(1.5));
		expect(to(" 2.5 ", "double")).toStrictEqual(new Double(2.5));
		expect(to(Decimal128.fromString("0.1"), "double")).toStrictEqual(
			new Double(0.1)
		);
		expect(String(to(2, "decimal"))).toBe("2");
		expect(String(to(0.1, "decimal"))).toBe("0.1");
		expect(String(to(1e21, "decimal"))).toBe("1000000000000000000000");
		expect(String(to(dec("2.25"), "decimal"))).toBe("2.25");
		expect(refusal("abc", "double")).toBe(
			`insert dans 't' : 'c' (float) n'accepte pas "abc"`
		);
		expect(
			refusal(dec("1.2345678901234567890123456789012345"), "decimal")
		).toMatch(/plus de 34 chiffres significatifs$/);
	});

	it("texte, booléen (mots de Postgres), date ISO (UTC sans fuseau), uuid", () => {
		expect(to(42, "string")).toBe("42");
		expect(to(dec("1.50"), "string")).toBe("1.50");
		expect(to(new UUID(U1), "string")).toBe(U1);
		expect(to("Yes", "bool")).toBe(true);
		expect(to(" f ", "bool")).toBe(false);
		expect(refusal(1, "bool")).toBe(
			"insert dans 't' : 'c' (bool) n'accepte pas 1"
		);
		expect(to("2024-03-01", "date")).toEqual(new Date("2024-03-01T00:00:00Z"));
		expect(to("2024-03-01 10:00", "date")).toEqual(
			new Date("2024-03-01T10:00:00Z")
		);
		expect(to("2024-03-01T10:00:00.250+02:00", "date")).toEqual(
			new Date("2024-03-01T08:00:00.250Z")
		);
		expect(refusal("2024-02-30", "date")).toBe(
			`insert dans 't' : 'c' (date) n'accepte pas "2024-02-30"`
		);
		expect(to(U1.toUpperCase(), "binData")).toStrictEqual(new UUID(U1));
		expect(to(`{${U1}}`, "binData")).toStrictEqual(new UUID(U1));
		expect(refusal("abc", "binData")).toBe(
			`insert dans 't' : 'c' (uuid) n'accepte pas "abc"`
		);
	});

	it("json et tableau depuis leur texte ; null et types non convertis gardés", () => {
		expect(to('{"a":1}', "object")).toEqual({ a: 1 });
		expect(to("[1,2]", "array")).toEqual([1, 2]);
		expect(refusal([1], "object")).toBe(
			"insert dans 't' : 'c' (json) n'accepte pas [1]"
		);
		expect(to(null, "long")).toBeNull();
		expect(to("x", "timestamp")).toBe("x");
	});

	it("convertValue : même conversion, sans refus nommé", () => {
		expect(convertValue(U1, "binData")).toEqual({
			ok: true,
			value: new UUID(U1)
		});
		expect(convertValue("abc", "binData")).toEqual({ ok: false });
		expect(convertValue("x", "")).toEqual({ ok: true, value: "x" });
	});
});

describe("documents, updates et pipelines d'écriture", () => {
	const types = new Map([
		["f", "double"],
		["u", "binData"],
		["s", "string"]
	]);

	it("seuls les champs déclarés sont convertis ; document inchangé rendu tel quel", () => {
		const doc = { f: 1, other: 1, _id: "x" };
		expect(toDeclaredTypes(doc, types, "w")).toEqual({
			f: new Double(1),
			other: 1,
			_id: "x"
		});
		const plain = { other: 1 };
		expect(toDeclaredTypes(plain, types, "w")).toBe(plain);
	});

	it("`$set` littéral converti côté client", () => {
		expect(declaredUpdate({ $set: { f: 2, u: U1 } }, types, "w")).toEqual({
			$set: { f: new Double(2), u: new UUID(U1) }
		});
	});

	it("forme pipeline : littéral converti, expression enveloppée, texte `$` gardé littéral", () => {
		const [stage] = declaredPipeline(
			[
				{
					$set: {
						f: { $ifNull: ["$n", null] },
						u: U1,
						s: { $literal: "$5" },
						n: "$m"
					}
				}
			],
			types,
			"w"
		);
		expect(stage).toEqual({
			$set: {
				f: {
					$let: {
						vars: { v: { $ifNull: ["$n", null] } },
						in: { $cond: [{ $isNumber: "$$v" }, { $toDouble: "$$v" }, "$$v"] }
					}
				},
				u: new UUID(U1),
				s: { $literal: "$5" },
				n: "$m"
			}
		});
		expect(declaredTypeExpr("$x", "date")).toBe("$x");
	});
});

describe("withUuidForms — un uuid texte matche aussi sa forme binaire", () => {
	it("égalité, `$nin` de `!=`, `$in`, `$and` ; `_id`, `$expr`, dates et sous-documents gardés", () => {
		const out = withUuidForms({
			u: U1,
			v: { $nin: [U1, null] },
			$and: [{ w: { $in: ["a", U1] } }],
			_id: U1,
			$expr: { $eq: ["$u", U1] },
			at: new Date(0),
			doc: { k: U1 }
		});
		expect(out).toEqual({
			u: { $in: [new UUID(U1), U1] },
			v: { $nin: [new UUID(U1), U1, null] },
			$and: [{ w: { $in: ["a", new UUID(U1), U1] } }],
			_id: U1,
			$expr: { $eq: ["$u", U1] },
			at: new Date(0),
			doc: { k: U1 }
		});
	});

	it("pipeline : `$match` et sous-pipeline de `$lookup`, jamais `$project`", () => {
		const out = pipelineWithUuidForms([
			{ $match: { u: U1 } },
			{ $lookup: { from: "x", pipeline: [{ $match: { u: U1 } }], as: "j" } },
			{ $project: { u: U1 } }
		]);
		expect(out).toEqual([
			{ $match: { u: { $in: [new UUID(U1), U1] } } },
			{
				$lookup: {
					from: "x",
					pipeline: [{ $match: { u: { $in: [new UUID(U1), U1] } } }],
					as: "j"
				}
			},
			{ $project: { u: U1 } }
		]);
	});
});
