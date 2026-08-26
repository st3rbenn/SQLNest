import { describe, expect, it } from "vitest";
import { extractSetFields, uniqueDefined } from "./adapter";

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
