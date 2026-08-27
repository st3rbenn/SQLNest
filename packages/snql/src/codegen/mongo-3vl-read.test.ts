import { describe, expect, it } from "vitest";
import { compile } from "../index";
import type { SchemaModel } from "../schema/model";

function pipe(source: string, schema?: SchemaModel): Record<string, unknown>[] {
	const { native } = compile(source, { engine: "mongodb", schema });
	if (native.kind !== "mongo") throw new Error("attendu mongo");
	return native.pipeline as Record<string, unknown>[];
}

const match = (source: string) => pipe(source)[0];

// ═══ ADR-032 — parité 3VL en lecture ═══════════════════════════════════════

describe("filtre existence-aware read (ADR-032 A)", () => {
	it("`x != v` → $nin [v, null] (exclut absent/null comme PG)", () => {
		expect(match('get t where x != "a"')).toEqual({
			$match: { x: { $nin: ["a", null] } }
		});
	});

	it("`not(x = v)` → $nin [v, null]", () => {
		expect(match('get t where not x = "a"')).toEqual({
			$match: { x: { $nin: ["a", null] } }
		});
	});

	it("`not in` → $nin [...vals, null]", () => {
		expect(match('get t where not x in ["a", "b"]')).toEqual({
			$match: { x: { $nin: ["a", "b", null] } }
		});
	});

	it("`not like` → $not $regex + $ne null", () => {
		const m = match('get t where not name like "bob%"') as {
			$match: { name: Record<string, unknown> };
		};
		expect(m.$match.name).toHaveProperty("$not");
		expect(m.$match.name).toHaveProperty("$ne", null);
	});

	it("positif lt/le/gt/ge inchangé (Mongo exclut déjà absent/null)", () => {
		expect(match("get t where age > 30")).toEqual({
			$match: { age: { $gt: 30 } }
		});
	});
});

describe("$expr gardé existence read (ADR-032 1b)", () => {
	it("champ↔champ positif `a = b` → gardes + $eq", () => {
		expect(match("get t where a = b")).toEqual({
			$match: {
				$expr: {
					$and: [{ $ne: ["$a", null] }, { $ne: ["$b", null] }, { $eq: ["$a", "$b"] }]
				}
			}
		});
	});

	it("champ↔champ négatif `not(a < b)` → gardes + $not", () => {
		expect(match("get t where not a < b")).toEqual({
			$match: {
				$expr: {
					$and: [
						{ $ne: ["$a", null] },
						{ $ne: ["$b", null] },
						{ $not: [{ $lt: ["$a", "$b"] }] }
					]
				}
			}
		});
	});
});

// ═══ ADR-032 — null-ordering au sort, schema-aware ═════════════════════════

const SCHEMA: SchemaModel = {
	engine: "mongodb",
	collections: [
		{
			name: "t",
			source: "declared",
			fields: [
				{ name: "id", type: "int", nullable: false, source: "declared" },
				{ name: "note", type: "string", nullable: true, source: "declared" }
			]
		}
	],
	relations: []
};

describe("sort null-rank schema-aware (ADR-032 C)", () => {
	it("clé `not null` (schema) → $sort plat, index préservé", () => {
		expect(pipe("find t sort id asc", SCHEMA)).toEqual([{ $sort: { id: 1 } }]);
	});

	it("clé nullable (schema) → null-rank de parité", () => {
		expect(pipe("find t sort note asc", SCHEMA)).toEqual([
			{ $addFields: { __nr_0: { $cond: [{ $eq: ["$note", null] }, 1, 0] } } },
			{ $sort: { __nr_0: 1, note: 1 } },
			{ $unset: ["__nr_0"] }
		]);
	});

	it("clés mixtes → rank seulement sur la nullable", () => {
		expect(pipe("find t sort id asc, note desc", SCHEMA)).toEqual([
			{ $addFields: { __nr_1: { $cond: [{ $eq: ["$note", null] }, 1, 0] } } },
			{ $sort: { id: 1, __nr_1: -1, note: -1 } },
			{ $unset: ["__nr_1"] }
		]);
	});

	it("DESC nullable → nulls first (rank -1 met 1 avant 0)", () => {
		const stages = pipe("find t sort note desc", SCHEMA);
		expect(stages[1]).toEqual({ $sort: { __nr_0: -1, note: -1 } });
	});
});
