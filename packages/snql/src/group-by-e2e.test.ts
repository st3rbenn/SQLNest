/**
 * group by / having E2E — parser + lower + planner + codegen
 * PG/Mongo + runtime KV bucket fold.
 */

import { describe, expect, it } from "vitest";
import { compensate } from "./runtime/compensate";
import { SnqlError } from "./diagnostics";
import type { Capability } from "./ir/plan";
import { SNQL_FUNCTIONS } from "./functions";
import { compile, plan } from "./index";

const scanOnly = {
	engine: "scan-only",
	supports: new Set<Capability>(["scan"]),
	functions: SNQL_FUNCTIONS.forEngine("kv"),
	castTargets: new Set<import("./ir/plan").CastTarget>([
		"int", "float", "text", "bool"
	])
};

function pgSql(source: string): { text: string; params: readonly unknown[] } {
	const { native } = compile(source, { engine: "postgres" });
	if (native.kind !== "sql") throw new Error("kind sql attendu");
	return { text: native.text, params: native.params };
}

function mongoPipeline(source: string): readonly Record<string, unknown>[] {
	const { native } = compile(source, { engine: "mongodb" });
	if (native.kind !== "mongo") throw new Error("kind mongo attendu");
	return native.pipeline;
}

function kvFold(source: string, rows: readonly Record<string, unknown>[]) {
	const logical = compile(source, { engine: "postgres" }).plan;
	const physical = plan(logical, scanOnly);
	return compensate(physical.compensation, rows);
}

function expectCode(fn: () => unknown, code: string): void {
	try {
		fn();
		throw new Error(`SnqlError attendu avec code=${code}`);
	} catch (e) {
		if (!(e instanceof SnqlError)) throw e;
		expect(e.code).toBe(code);
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// Parser : group by / having
// ═══════════════════════════════════════════════════════════════════════════

describe("parser group by / having", () => {
	it("group by x accepté", () => {
		expect(() => pgSql("find t group by x pick x, count(*) as n")).not.toThrow();
	});

	it("group by x, y accepté (multi-key)", () => {
		expect(() =>
			pgSql("find t group by x, y pick x, y, count(*) as n")
		).not.toThrow();
	});

	it("group sans by refusé", () => {
		expectCode(
			() => pgSql("find t group x pick x, count(*) as n"),
			"parse_group_missing_by"
		);
	});

	it("having accepté après group by", () => {
		expect(() =>
			pgSql("find t group by x having count(*) > 5 pick x, count(*) as n")
		).not.toThrow();
	});

	it("ordre canonique respecté (group avant having, avant pick/sort/limit)", () => {
		expect(() =>
			pgSql(
				"find t where a = 1 group by x having count(*) > 2 pick x, count(*) as n sort x limit 10"
			)
		).not.toThrow();
	});

	it("group après pick refusé (ordre)", () => {
		expectCode(
			() => pgSql("find t pick x, count(*) as n group by x"),
			"parse_stage_out_of_order"
		);
	});

	it("having après pick refusé (ordre)", () => {
		expectCode(
			() => pgSql("find t group by x pick x, count(*) as n having count(*) > 1"),
			"parse_stage_out_of_order"
		);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Lower : validations
// ═══════════════════════════════════════════════════════════════════════════

describe("lower group by / having", () => {
	it("having sans group by refusé", () => {
		expectCode(
			() => pgSql("find t having count(*) > 5 pick count(*) as n"),
			"lower_having_without_group"
		);
	});

	it("group by sans pick refusé", () => {
		expectCode(
			() => pgSql("find t group by x"),
			"lower_group_without_pick"
		);
	});

	it("group by clé dupliquée refusé", () => {
		expectCode(
			() => pgSql("find t group by x, x pick x, count(*) as n"),
			"lower_group_duplicate_key"
		);
	});

	it("pick contient un champ ni group key ni agg → refusé", () => {
		expectCode(
			() => pgSql("find t group by x pick x, y, count(*) as n"),
			"planner_agg_bare_field_needs_group"
		);
	});

	it("pick contient group key (bare field) → accepté", () => {
		expect(() =>
			pgSql("find t group by year pick year, count(*) as n")
		).not.toThrow();
	});

	it("having contient champ hors group by → refusé", () => {
		expectCode(
			() => pgSql("find t group by x having y > 5 pick x, count(*) as n"),
			"lower_bare_field_in_agg_scalar_wrapper"
		);
	});

	it("having contient champ dans group by → accepté", () => {
		expect(() =>
			pgSql("find t group by x having x = 1 pick x, count(*) as n")
		).not.toThrow();
	});

	it("having contient aggregate → accepté", () => {
		expect(() =>
			pgSql("find t group by x having count(*) > 5 pick x, count(*) as n")
		).not.toThrow();
	});

	it("group by avec alias source (u.year) strip", () => {
		expect(() =>
			pgSql("find t as u group by u.year pick u.year, count(*) as n")
		).not.toThrow();
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Codegen PG : GROUP BY + HAVING
// ═══════════════════════════════════════════════════════════════════════════

describe("codegen PG", () => {
	it("group by simple", () => {
		expect(pgSql("find t group by x pick x, count(*) as n").text).toBe(
			`SELECT "x", COUNT(*) AS "n" FROM "t" GROUP BY "x"`
		);
	});

	it("group by multi-key", () => {
		expect(
			pgSql("find t group by x, y pick x, y, count(*) as n").text
		).toBe(
			`SELECT "x", "y", COUNT(*) AS "n" FROM "t" GROUP BY "x", "y"`
		);
	});

	it("having sur agg", () => {
		expect(
			pgSql("find t group by x having count(*) > 5 pick x, count(*) as n").text
		).toBe(
			`SELECT "x", COUNT(*) AS "n" FROM "t" GROUP BY "x" HAVING COUNT(*) > $1`
		);
	});

	it("where + group + having + pick + sort + limit", () => {
		const { text } = pgSql(
			`find t where a = 1 group by x having count(*) > 2 pick x, count(*) as n sort x limit 10`
		);
		expect(text).toBe(
			`SELECT "x", COUNT(*) AS "n" FROM "t" WHERE "a" = $1 GROUP BY "x" HAVING COUNT(*) > $2 ORDER BY "x" ASC LIMIT $3`
		);
	});

	it("sum + group by", () => {
		expect(
			pgSql("find t group by x pick x, sum(y) as total").text
		).toBe(
			`SELECT "x", SUM("y")::double precision AS "total" FROM "t" GROUP BY "x"`
		);
	});

	it("group by alias strippé au codegen", () => {
		expect(
			pgSql("find t as u group by u.x pick u.x, count(*) as n").text
		).toBe(
			`SELECT "u"."x", COUNT(*) AS "n" FROM "t" AS "u" GROUP BY "x"`
		);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Codegen Mongo : _id object + $match having
// ═══════════════════════════════════════════════════════════════════════════

describe("codegen Mongo", () => {
	it("group by → _id flat object", () => {
		const pipeline = mongoPipeline("find t group by x pick x, count(*) as n");
		expect(pipeline[0]).toEqual({
			$group: { _id: { x: "$x" }, __agg_0: { $sum: 1 } }
		});
		expect(pipeline[1]).toEqual({
			$project: { _id: 0, x: "$_id.x", n: "$__agg_0" }
		});
	});

	it("group by multi-key → _id flat object multi", () => {
		const pipeline = mongoPipeline(
			"find t group by x, y pick x, y, count(*) as n"
		);
		expect(pipeline[0]).toEqual({
			$group: { _id: { x: "$x", y: "$y" }, __agg_0: { $sum: 1 } }
		});
		expect(pipeline[1]).toEqual({
			$project: { _id: 0, x: "$_id.x", y: "$_id.y", n: "$__agg_0" }
		});
	});

	it("having → $match {$expr:...} après $project", () => {
		const pipeline = mongoPipeline(
			"find t group by x having count(*) > 5 pick x, count(*) as n"
		);
		expect(pipeline.length).toBe(3);
		expect(pipeline[2]).toEqual({
			$match: { $expr: { $gt: ["$n", 5] } }
		});
	});

	it("sort par alias du pick → $sort APRÈS $project (pas de reorder)", () => {
		// L'alias `n` est défini par le $project ; $sort doit venir après.
		const pipeline = mongoPipeline(
			"find t group by x pick x, count(*) as n sort n desc limit 10"
		);
		// [$group, $project, $sort, $limit]
		expect(pipeline.length).toBe(4);
		expect(pipeline[2]).toEqual({ $sort: { n: -1 } });
		expect(pipeline[3]).toEqual({ $limit: 10 });
	});

	it("sort par source col droppée par pick (non-agg) → $sort AVANT $project", () => {
		// created_at n'est PAS dans pick → auto-reorder pour préserver l'accès.
		const pipeline = mongoPipeline(
			"find users pick name, email sort created_at desc"
		);
		expect(pipeline).toEqual([
			{ $sort: { created_at: -1 } },
			{ $project: { name: 1, email: 1, _id: 0 } }
		]);
	});

	it("having agg not in pick → hslot + $unset", () => {
		const pipeline = mongoPipeline(
			"find t group by x having sum(y) > 100 pick x, count(*) as n"
		);
		// $group: {_id:{x:$x}, __agg_0: $sum:1 (count), __agg_1: $sum:$y}
		// $project: {_id:0, x:$_id.x, n:$__agg_0, __hslot_0:$__agg_1}
		// $match: {$expr: {$gt: [$__hslot_0, 100]}}
		// $unset: ["__hslot_0"]
		expect(pipeline.length).toBe(4);
		expect(pipeline[3]).toEqual({ $unset: ["__hslot_0"] });
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Runtime KV : bucketFoldAggregate + having
// ═══════════════════════════════════════════════════════════════════════════

describe("runtime KV bucket fold", () => {
	it("group by 1 key + count", () => {
		const rows = [
			{ dept: "eng", salary: 100 },
			{ dept: "eng", salary: 200 },
			{ dept: "sales", salary: 150 }
		];
		const result = kvFold(
			"find t group by dept pick dept, count(*) as n",
			rows
		);
		expect(result).toHaveLength(2);
		expect(result).toContainEqual({ dept: "eng", n: 2 });
		expect(result).toContainEqual({ dept: "sales", n: 1 });
	});

	it("group by multi-key + sum", () => {
		const rows = [
			{ dept: "eng", year: 2024, sal: 100 },
			{ dept: "eng", year: 2024, sal: 200 },
			{ dept: "eng", year: 2025, sal: 300 },
			{ dept: "sales", year: 2024, sal: 150 }
		];
		const result = kvFold(
			"find t group by dept, year pick dept, year, sum(sal) as total",
			rows
		);
		expect(result).toHaveLength(3);
		expect(result).toContainEqual({ dept: "eng", year: 2024, total: 300 });
		expect(result).toContainEqual({ dept: "eng", year: 2025, total: 300 });
		expect(result).toContainEqual({ dept: "sales", year: 2024, total: 150 });
	});

	it("having filter les buckets", () => {
		const rows = [
			{ dept: "eng", sal: 100 },
			{ dept: "eng", sal: 200 },
			{ dept: "sales", sal: 150 }
		];
		const result = kvFold(
			"find t group by dept having count(*) > 1 pick dept, count(*) as n",
			rows
		);
		expect(result).toEqual([{ dept: "eng", n: 2 }]);
	});

	it("having sur agg not in pick", () => {
		const rows = [
			{ dept: "eng", sal: 100 },
			{ dept: "eng", sal: 200 },
			{ dept: "sales", sal: 150 }
		];
		const result = kvFold(
			"find t group by dept having sum(sal) > 200 pick dept, count(*) as n",
			rows
		);
		expect(result).toEqual([{ dept: "eng", n: 2 }]);
	});

	it("having sur group key", () => {
		const rows = [
			{ dept: "eng", sal: 100 },
			{ dept: "sales", sal: 150 }
		];
		const result = kvFold(
			`find t group by dept having dept = "eng" pick dept, count(*) as n`,
			rows
		);
		expect(result).toEqual([{ dept: "eng", n: 1 }]);
	});

	it("empty collection avec group by → 0 buckets", () => {
		const result = kvFold(
			"find t group by dept pick dept, count(*) as n",
			[]
		);
		expect(result).toEqual([]);
	});

	it("null values group ensemble (bucket all-null)", () => {
		const rows = [
			{ dept: null, sal: 100 },
			{ dept: null, sal: 200 },
			{ dept: "eng", sal: 300 }
		];
		const result = kvFold(
			"find t group by dept pick dept, count(*) as n",
			rows
		);
		expect(result).toHaveLength(2);
		expect(result).toContainEqual({ dept: null, n: 2 });
		expect(result).toContainEqual({ dept: "eng", n: 1 });
	});
});
