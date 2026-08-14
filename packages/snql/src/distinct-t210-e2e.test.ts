/**
 * Sprint T2/10 DISTINCT E2E — pick unique / pick unique on (keys).
 * Parser + lower + codegen PG/Mongo + runtime KV dedup.
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
// Parser : pick unique / pick unique on (keys)
// ═══════════════════════════════════════════════════════════════════════════

describe("parser DISTINCT", () => {
	it("pick unique field accepté", () => {
		expect(() => pgSql("find t pick unique name")).not.toThrow();
	});

	it("pick unique multi-fields accepté", () => {
		expect(() => pgSql("find t pick unique name, email")).not.toThrow();
	});

	it("pick unique on (k) accepté", () => {
		expect(() =>
			pgSql("find t pick unique on (chromosome) chromosome, locus_start")
		).not.toThrow();
	});

	it("pick unique on (k1, k2) multi-key accepté", () => {
		expect(() =>
			pgSql("find t pick unique on (a, b) a, b, c")
		).not.toThrow();
	});

	it("pick unique on sans parens refusé", () => {
		expect(() =>
			pgSql("find t pick unique on chromosome chromosome, name")
		).toThrow(/parens/);
	});

	it("champ nommé 'unique' passe comme field (pas de on/ident derrière)", () => {
		// `pick unique` sans autre ident → parse fallback échoue plus tard
		// (le parser attend un field après). Test cette forme :
		// `pick unique, name` — 'unique' devrait rester field.
		// En pratique le parser prend `unique` comme modifier si suivi d'ident,
		// donc `pick unique, name` → parse `unique` puis `name`, ratant `unique` field.
		// Design choix : `unique` est modifier si suivi d'ident/on/expr, donc pas
		// de test facile pour "unique comme field". On teste `pick t.unique`.
		expect(() => pgSql("find t pick t.unique")).not.toThrow();
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Lower : validations
// ═══════════════════════════════════════════════════════════════════════════

describe("lower DISTINCT", () => {
	it("unique + group by refusé", () => {
		expectCode(
			() => pgSql("find t group by g pick unique g, count(*) as n"),
			"lower_unique_with_group"
		);
	});

	it("unique + aggregate dans même pick refusé", () => {
		expectCode(
			() => pgSql("find t pick unique count(*) as n"),
			"lower_unique_with_aggregate"
		);
	});

	it("unique + window function refusé", () => {
		expectCode(
			() => pgSql("find t pick unique x, row_number() over () as rn"),
			"lower_unique_with_window"
		);
	});

	it("unique on (k) avec k absent des fields refusé", () => {
		expectCode(
			() => pgSql("find t pick unique on (chromosome) name"),
			"lower_unique_on_key_not_projected"
		);
	});

	it("unique on + sort prefix mismatch refusé", () => {
		expectCode(
			() =>
				pgSql(
					"find t pick unique on (chromosome) chromosome, locus_start sort locus_start"
				),
			"lower_unique_on_sort_prefix_mismatch"
		);
	});

	it("unique on + sort prefix matching accepté", () => {
		expect(() =>
			pgSql(
				"find t pick unique on (chromosome) chromosome, locus_start sort chromosome, locus_start"
			)
		).not.toThrow();
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Codegen PG : DISTINCT / DISTINCT ON
// ═══════════════════════════════════════════════════════════════════════════

describe("codegen PG", () => {
	it("unique → SELECT DISTINCT", () => {
		expect(pgSql("find t pick unique name").text).toBe(
			`SELECT DISTINCT "name" FROM "t"`
		);
	});

	it("unique multi-fields", () => {
		expect(pgSql("find t pick unique name, email").text).toBe(
			`SELECT DISTINCT "name", "email" FROM "t"`
		);
	});

	it("unique on (k) → SELECT DISTINCT ON (k)", () => {
		expect(
			pgSql("find t pick unique on (chromosome) chromosome, locus_start").text
		).toBe(
			`SELECT DISTINCT ON ("chromosome") "chromosome", "locus_start" FROM "t"`
		);
	});

	it("unique on multi-key + sort matching", () => {
		expect(
			pgSql(
				"find t pick unique on (a, b) a, b, c sort a, b desc"
			).text
		).toBe(
			`SELECT DISTINCT ON ("a", "b") "a", "b", "c" FROM "t" ORDER BY "a" ASC, "b" DESC`
		);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Codegen Mongo : $group + $first
// ═══════════════════════════════════════════════════════════════════════════

describe("codegen Mongo", () => {
	it("unique → $project + $group + $project back", () => {
		const pipeline = mongoPipeline("find t pick unique name");
		// [$project{name:1,_id:0}, $group{_id:{name:$name}}, $project{name:$_id.name,_id:0}]
		expect(pipeline.length).toBe(3);
		expect(pipeline[1]).toEqual({ $group: { _id: { name: "$name" } } });
	});

	it("unique on (k) → $group par k + $first sur autres", () => {
		const pipeline = mongoPipeline(
			"find t pick unique on (chromosome) chromosome, locus_start"
		);
		expect(pipeline[1]).toEqual({
			$group: {
				_id: { chromosome: "$chromosome" },
				locus_start: { $first: "$locus_start" }
			}
		});
	});

	it("unique on multi-key", () => {
		const pipeline = mongoPipeline(
			"find t pick unique on (a, b) a, b, c"
		);
		expect(pipeline[1]).toEqual({
			$group: {
				_id: { a: "$a", b: "$b" },
				c: { $first: "$c" }
			}
		});
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Runtime KV : dedup
// ═══════════════════════════════════════════════════════════════════════════

describe("runtime KV DISTINCT", () => {
	it("unique dédup rows identiques", () => {
		const rows = [
			{ name: "a" }, { name: "b" }, { name: "a" }, { name: "c" }
		];
		const result = kvFold("find t pick unique name", rows);
		expect(result).toEqual([
			{ name: "a" }, { name: "b" }, { name: "c" }
		]);
	});

	it("unique multi-fields dédup par tuple", () => {
		const rows = [
			{ a: 1, b: 2 },
			{ a: 1, b: 3 },
			{ a: 1, b: 2 },
			{ a: 2, b: 2 }
		];
		const result = kvFold("find t pick unique a, b", rows);
		expect(result).toEqual([
			{ a: 1, b: 2 },
			{ a: 1, b: 3 },
			{ a: 2, b: 2 }
		]);
	});

	it("unique on (k) garde la 1re row de chaque groupe", () => {
		const rows = [
			{ dept: "eng", sal: 100 },
			{ dept: "eng", sal: 200 },
			{ dept: "sales", sal: 90 },
			{ dept: "sales", sal: 110 }
		];
		const result = kvFold(
			"find t pick unique on (dept) dept, sal",
			rows
		);
		// La 1re row de chaque bucket : eng→100, sales→90.
		expect(result).toEqual([
			{ dept: "eng", sal: 100 },
			{ dept: "sales", sal: 90 }
		]);
	});

	it("unique on + sort matching → la 1re après tri", () => {
		const rows = [
			{ dept: "eng", sal: 100 },
			{ dept: "eng", sal: 200 },
			{ dept: "sales", sal: 90 }
		];
		const result = kvFold(
			"find t pick unique on (dept) dept, sal sort dept, sal desc",
			rows
		);
		// Sort par dept asc puis sal desc → eng[200,100], sales[90] ; unique on dept → 1re de chaque groupe.
		expect(result).toEqual([
			{ dept: "eng", sal: 200 },
			{ dept: "sales", sal: 90 }
		]);
	});
});
