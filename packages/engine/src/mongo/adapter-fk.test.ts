import { Binary, Decimal128, Double, Int32, Long, ObjectId } from "mongodb";
import { describe, expect, it } from "vitest";
import {
	bsonMatchKey,
	extractSetFields,
	pipelineSetColumns,
	uniqueDefined
} from "./adapter";

describe("extractSetFields (ADR-031 FK/1b write-precheck)", () => {
	it("lit $set classique", () => {
		expect(extractSetFields({ $set: { user_id: "u1", note: "x" } })).toEqual({
			user_id: "u1",
			note: "x"
		});
	});

	it("lit la forme pipeline [{$set}]", () => {
		expect(
			extractSetFields([{ $set: { user_id: "u1" } }, { $set: { flag: true } }])
		).toEqual({ user_id: "u1", flag: true });
	});

	it("update sans $set → objet vide", () => {
		expect(extractSetFields({ $inc: { n: 1 } })).toEqual({});
	});
});

describe("pipelineSetColumns (ADR-031 write-join)", () => {
	it("colonnes affectées, sans les alias de jointure retirés par $unset", () => {
		expect(
			pipelineSetColumns([
				{ $match: { label: "k1" } },
				{
					$lookup: {
						from: "m",
						localField: "label",
						foreignField: "label",
						as: "m"
					}
				},
				{ $unwind: { path: "$m" } },
				{ $set: { par_code: "$m.code", note: "x" } },
				{ $unset: ["m"] },
				{ $merge: { into: "kid" } }
			])
		).toEqual(["par_code", "note"]);
	});

	it("$unset en chaîne et $addFields", () => {
		expect(
			pipelineSetColumns([
				{ $addFields: { __sq_0: 1, total: 2 } },
				{ $unset: "__sq_0" }
			])
		).toEqual(["total"]);
	});
});

describe("uniqueDefined (ADR-031 FK/1b cascade keys)", () => {
	it("dédup + retire null/undefined", () => {
		expect(uniqueDefined(["a", "a", null, "b", undefined, "b"])).toEqual([
			"a",
			"b"
		]);
	});

	it("dédup des objets par valeur", () => {
		const out = uniqueDefined([{ x: 1 }, { x: 1 }, { x: 2 }]);
		expect(out).toHaveLength(2);
	});

	it("liste vide", () => {
		expect(uniqueDefined([])).toEqual([]);
	});
});

describe("bsonMatchKey (ADR-036 E/1a préflight add ref)", () => {
	const hex = "507f1f77bcf86cd799439011";

	it("ObjectId et chaîne de même hex ne se confondent pas (comme $in)", () => {
		expect(bsonMatchKey(new ObjectId(hex))).not.toBe(bsonMatchKey(hex));
		expect(bsonMatchKey(new ObjectId(hex))).toBe(
			bsonMatchKey(new ObjectId(hex))
		);
	});

	it("les numériques égaux matchent quel que soit leur type BSON", () => {
		const keys = [
			3,
			new Int32(3),
			new Long(3),
			new Double(3),
			Decimal128.fromString("3")
		].map(bsonMatchKey);
		expect(new Set(keys).size).toBe(1);
	});

	it("un uuid binaire se compare par sous-type et contenu", () => {
		const a = new Binary(Buffer.from("0123456789abcdef"), 4);
		const b = new Binary(Buffer.from("0123456789abcdef"), 4);
		const c = new Binary(Buffer.from("0123456789abcdef"), 0);
		expect(bsonMatchKey(a)).toBe(bsonMatchKey(b));
		expect(bsonMatchKey(a)).not.toBe(bsonMatchKey(c));
	});

	it("chaîne et nombre de même texte restent distincts", () => {
		expect(bsonMatchKey("3")).not.toBe(bsonMatchKey(3));
	});
});
