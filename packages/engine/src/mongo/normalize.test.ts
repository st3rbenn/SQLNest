import { describe, expect, it } from "vitest";
import { normalizeBson } from "./adapter";

/** Faux objets BSON : le driver les distingue par `_bsontype` + un `toString()`. */
const objectId = {
	_bsontype: "ObjectId",
	toString: () => "507f1f77bcf86cd799439011"
};
const decimal = { _bsontype: "Decimal128", toString: () => "12.50" };
const long = { _bsontype: "Long", toString: () => "9007199254740993" };
const int32 = { _bsontype: "Int32", toString: () => "42" };

describe("normalizeBson", () => {
	it("ramène les types BSON à des scalaires portables", () => {
		const date = new Date("2020-01-01T00:00:00.000Z");
		const out = normalizeBson({
			_id: objectId,
			price: decimal,
			big: long,
			n: int32,
			when: date,
			name: "x",
			nested: { inner: objectId }
		}) as Record<string, unknown>;

		expect(out._id).toBe("507f1f77bcf86cd799439011");
		expect(out.price).toBe("12.50"); // Decimal128 → chaîne décimale exacte
		expect(out.big).toBe(9007199254740993n); // > 2^53 → bigint (précision)
		expect(out.n).toBe(42);
		expect(out.when).toBe(date); // Date inchangé (comme pg)
		expect(out.name).toBe("x");
		expect((out.nested as Record<string, unknown>).inner).toBe(
			"507f1f77bcf86cd799439011"
		);
	});

	it("laisse passer les scalaires JS", () => {
		expect(normalizeBson(5)).toBe(5);
		expect(normalizeBson(null)).toBe(null);
		expect(normalizeBson("s")).toBe("s");
		expect(normalizeBson(true)).toBe(true);
	});

	it("normalise les éléments d'un tableau", () => {
		expect(normalizeBson([objectId, 1, "x"])).toEqual([
			"507f1f77bcf86cd799439011",
			1,
			"x"
		]);
	});
});
