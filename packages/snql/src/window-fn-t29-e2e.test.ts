/**
 * Sprint T2/9 window functions E2E — row_number / rank / dense_rank avec
 * over (partition ... sort ...). Parser + lower + codegen PG/Mongo +
 * runtime KV pre-project.
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
// Parser : postfix over (...)
// ═══════════════════════════════════════════════════════════════════════════

describe("parser window functions", () => {
	it("row_number() over () accepté (window global)", () => {
		expect(() => pgSql("find t pick x, row_number() over () as rn")).not.toThrow();
	});

	it("row_number() over (partition x sort y) accepté", () => {
		expect(() =>
			pgSql("find t pick x, row_number() over (partition x sort y) as rn")
		).not.toThrow();
	});

	it("row_number() over (partition x, y sort a asc, b desc) multi-key accepté", () => {
		expect(() =>
			pgSql(
				"find t pick x, y, row_number() over (partition x, y sort a asc, b desc) as rn"
			)
		).not.toThrow();
	});

	it("over sur non-window (upper) refusé", () => {
		expectCode(
			() => pgSql("find t pick upper(name) over () as u"),
			"parse_over_not_window"
		);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Lower : validation position
// ═══════════════════════════════════════════════════════════════════════════

describe("lower window functions", () => {
	it("window dans where refusé", () => {
		expectCode(
			() => pgSql("find t where row_number() over () > 5 pick x"),
			"lower_window_in_where"
		);
	});

	it("window dans having refusé", () => {
		expectCode(
			() =>
				pgSql(
					"find t group by x having row_number() over () > 5 pick x, count(*) as n"
				),
			"lower_window_in_having"
		);
	});

	it("window + aggregate dans même pick refusé", () => {
		expectCode(
			() =>
				pgSql(
					"find t pick x, count(*) as n, row_number() over () as rn"
				),
			"lower_window_agg_mix"
		);
	});

	it("window après group by refusé", () => {
		expectCode(
			() =>
				pgSql(
					"find t group by x pick x, row_number() over () as rn"
				),
			"lower_window_after_group"
		);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Codegen PG : OVER clause
// ═══════════════════════════════════════════════════════════════════════════

describe("codegen PG", () => {
	it("row_number() over () → OVER ()", () => {
		expect(pgSql("find t pick x, row_number() over () as rn").text).toBe(
			`SELECT "x", ROW_NUMBER() OVER () AS "rn" FROM "t"`
		);
	});

	it("row_number() over (partition x sort y)", () => {
		expect(
			pgSql("find t pick x, row_number() over (partition x sort y) as rn").text
		).toBe(
			`SELECT "x", ROW_NUMBER() OVER (PARTITION BY "x" ORDER BY "y" ASC) AS "rn" FROM "t"`
		);
	});

	it("rank + dense_rank cohabitent", () => {
		const { text } = pgSql(
			"find t pick x, rank() over (partition x sort y desc) as r, dense_rank() over (partition x sort y desc) as dr"
		);
		expect(text).toContain(`RANK() OVER (PARTITION BY "x" ORDER BY "y" DESC)`);
		expect(text).toContain(
			`DENSE_RANK() OVER (PARTITION BY "x" ORDER BY "y" DESC)`
		);
	});

	it("partition multi-key + sort multi-key", () => {
		expect(
			pgSql(
				"find t pick x, y, row_number() over (partition x, y sort a asc, b desc) as rn"
			).text
		).toBe(
			`SELECT "x", "y", ROW_NUMBER() OVER (PARTITION BY "x", "y" ORDER BY "a" ASC, "b" DESC) AS "rn" FROM "t"`
		);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Codegen Mongo : $setWindowFields
// ═══════════════════════════════════════════════════════════════════════════

describe("codegen Mongo", () => {
	it("row_number() over () → $setWindowFields + $project", () => {
		const pipeline = mongoPipeline("find t pick x, row_number() over () as rn");
		expect(pipeline[0]).toEqual({
			$setWindowFields: {
				partitionBy: null,
				output: { __win_0: { $documentNumber: {} } }
			}
		});
		expect(pipeline[1]).toEqual({
			$project: { x: 1, rn: "$__win_0", _id: 0 }
		});
	});

	it("row_number over (partition x sort y) → partitionBy $x + sortBy", () => {
		const pipeline = mongoPipeline(
			"find t pick x, row_number() over (partition x sort y) as rn"
		);
		expect(pipeline[0]).toEqual({
			$setWindowFields: {
				partitionBy: "$x",
				output: { __win_0: { $documentNumber: {} } },
				sortBy: { y: 1 }
			}
		});
	});

	it("rank + dense_rank partagent $setWindowFields (même partition/sort)", () => {
		const pipeline = mongoPipeline(
			"find t pick x, rank() over (partition x sort y) as r, dense_rank() over (partition x sort y) as dr"
		);
		expect(pipeline[0]).toEqual({
			$setWindowFields: {
				partitionBy: "$x",
				output: {
					__win_0: { $rank: {} },
					__win_1: { $denseRank: {} }
				},
				sortBy: { y: 1 }
			}
		});
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Runtime KV : bucket + sort + assign
// ═══════════════════════════════════════════════════════════════════════════

describe("runtime KV window", () => {
	it("row_number() over () assigne 1..N global", () => {
		const rows = [
			{ x: 10 }, { x: 20 }, { x: 30 }
		];
		const result = kvFold("find t pick x, row_number() over () as rn", rows);
		expect(result).toEqual([
			{ x: 10, rn: 1 },
			{ x: 20, rn: 2 },
			{ x: 30, rn: 3 }
		]);
	});

	it("row_number() over (partition dept sort sal desc)", () => {
		const rows = [
			{ dept: "eng", sal: 100 },
			{ dept: "eng", sal: 200 },
			{ dept: "eng", sal: 150 },
			{ dept: "sales", sal: 90 },
			{ dept: "sales", sal: 110 }
		];
		const result = kvFold(
			"find t pick dept, sal, row_number() over (partition dept sort sal desc) as rn",
			rows
		);
		// Chaque dept a son propre 1,2,...
		const engRows = result.filter((r) => r.dept === "eng").sort((a, b) => (a.rn as number) - (b.rn as number));
		expect(engRows).toEqual([
			{ dept: "eng", sal: 200, rn: 1 },
			{ dept: "eng", sal: 150, rn: 2 },
			{ dept: "eng", sal: 100, rn: 3 }
		]);
		const salesRows = result.filter((r) => r.dept === "sales").sort((a, b) => (a.rn as number) - (b.rn as number));
		expect(salesRows).toEqual([
			{ dept: "sales", sal: 110, rn: 1 },
			{ dept: "sales", sal: 90, rn: 2 }
		]);
	});

	it("rank() saute les ties (1, 1, 3)", () => {
		const rows = [
			{ x: 100 }, { x: 100 }, { x: 200 }
		];
		const result = kvFold(
			"find t pick x, rank() over (sort x asc) as r",
			rows
		);
		const sorted = [...result].sort((a, b) => (a.x as number) - (b.x as number));
		expect(sorted).toEqual([
			{ x: 100, r: 1 },
			{ x: 100, r: 1 },
			{ x: 200, r: 3 }
		]);
	});

	it("dense_rank() ne saute pas les ties (1, 1, 2)", () => {
		const rows = [
			{ x: 100 }, { x: 100 }, { x: 200 }
		];
		const result = kvFold(
			"find t pick x, dense_rank() over (sort x asc) as dr",
			rows
		);
		const sorted = [...result].sort((a, b) => (a.x as number) - (b.x as number));
		expect(sorted).toEqual([
			{ x: 100, dr: 1 },
			{ x: 100, dr: 1 },
			{ x: 200, dr: 2 }
		]);
	});
});
