/**
 * aggregateMulti E2E — array_agg / string_agg / json_agg avec
 * sort intra-call. Parser + lower + codegen PG/Mongo + runtime KV.
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
// Parser : sort intra-call contextuel
// ═══════════════════════════════════════════════════════════════════════════

describe("parser sort intra-call", () => {
	it("array_agg(x) sans sort accepté", () => {
		expect(() => pgSql("find t group by g pick g, array_agg(x) as vals")).not.toThrow();
	});

	it("array_agg(x sort x asc) accepté", () => {
		expect(() =>
			pgSql("find t group by g pick g, array_agg(x sort x asc) as vals")
		).not.toThrow();
	});

	it("string_agg(name, \", \" sort name) accepté", () => {
		expect(() =>
			pgSql(`find t group by g pick g, string_agg(name, ", " sort name) as list`)
		).not.toThrow();
	});

	it("array_agg multi-key sort accepté", () => {
		expect(() =>
			pgSql("find t group by g pick g, array_agg(x sort x asc, y desc) as vals")
		).not.toThrow();
	});

	it("sort dans call scalar (upper) → sort reste stage classique (erreur parse)", () => {
		// upper.kind !== aggregateMulti → parser laisse `sort` comme stage keyword.
		// La ')' manque → parseCall throw.
		expect(() => pgSql("find t pick upper(name sort name) as u")).toThrow();
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Lower : validation sortKeys + unique aggregateMulti
// ═══════════════════════════════════════════════════════════════════════════

describe("lower aggregateMulti", () => {
	it("unique accepté sur array_agg", () => {
		expect(() =>
			pgSql("find t group by g pick g, array_agg(unique x) as uniques")
		).not.toThrow();
	});

	it("string_agg(unique x, sep sort k) — fast-path unique accepte 2+ args pour aggregateMulti", () => {
		// Régression E2E : le fast-path unique de refusait structurellement
		// les args supplémentaires, mais string_agg(unique x, sep) en a besoin.
		expect(() =>
			pgSql(
				`find t group by g pick g, string_agg(unique name, ", " sort name asc) as list`
			)
		).not.toThrow();
	});

	it("count(unique x, y) toujours refusé — aggregate scalar reste mono-arg", () => {
		expectCode(
			() => pgSql("find t group by g pick g, count(unique x, y) as n"),
			"parse_call_unique_extra_args"
		);
	});

	it("aggregateMulti dans where refusé (comme aggregate)", () => {
		expectCode(
			() => pgSql("find t where array_agg(x) > 0"),
			"lower_agg_in_where"
		);
	});

	it("aggregateMulti nested dans un aggregate refusé", () => {
		expectCode(
			() => pgSql("find t group by g pick g, count(array_agg(x)) as n"),
			"lower_agg_nested"
		);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Codegen PG : ARRAY_AGG / STRING_AGG / JSON_AGG
// ═══════════════════════════════════════════════════════════════════════════

describe("codegen PG", () => {
	it("array_agg simple", () => {
		expect(pgSql("find t group by g pick g, array_agg(x) as vals").text).toBe(
			`SELECT "g", ARRAY_AGG("x") AS "vals" FROM "t" GROUP BY "g"`
		);
	});

	it("array_agg avec sort intra-call", () => {
		expect(
			pgSql("find t group by g pick g, array_agg(x sort x desc) as vals").text
		).toBe(
			`SELECT "g", ARRAY_AGG("x" ORDER BY "x" DESC) AS "vals" FROM "t" GROUP BY "g"`
		);
	});

	it("array_agg(unique) → ARRAY_AGG(DISTINCT)", () => {
		expect(
			pgSql("find t group by g pick g, array_agg(unique x) as u").text
		).toBe(
			`SELECT "g", ARRAY_AGG(DISTINCT "x") AS "u" FROM "t" GROUP BY "g"`
		);
	});

	it("string_agg avec sep + sort", () => {
		expect(
			pgSql(`find t group by g pick g, string_agg(name, ", " sort name) as list`).text
		).toBe(
			`SELECT "g", STRING_AGG(("name")::text, $1 ORDER BY "name" ASC) AS "list" FROM "t" GROUP BY "g"`
		);
	});

	it("json_agg avec sort multi-key", () => {
		expect(
			pgSql("find t group by g pick g, json_agg(row sort a asc, b desc) as arr").text
		).toBe(
			`SELECT "g", JSON_AGG("row" ORDER BY "a" ASC, "b" DESC) AS "arr" FROM "t" GROUP BY "g"`
		);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Codegen Mongo : $push + $sortArray + string_agg $reduce
// ═══════════════════════════════════════════════════════════════════════════

describe("codegen Mongo", () => {
	it("array_agg → $push en $group + projection directe", () => {
		const pipeline = mongoPipeline(
			"find t group by g pick g, array_agg(x) as vals"
		);
		expect(pipeline[0]).toEqual({
			$group: { _id: { g: "$g" }, __agg_0: { $push: "$x" } }
		});
		expect(pipeline[1]).toEqual({
			$project: { _id: 0, g: "$_id.g", vals: "$__agg_0" }
		});
	});

	it("array_agg avec sort intra-call → $sortArray en $project", () => {
		const pipeline = mongoPipeline(
			"find t group by g pick g, array_agg(x sort x desc) as vals"
		);
		expect(pipeline[1]).toEqual({
			$project: {
				_id: 0,
				g: "$_id.g",
				vals: { $sortArray: { input: "$__agg_0", sortBy: { x: -1 } } }
			}
		});
	});

	it("array_agg(unique) → $addToSet en $group", () => {
		const pipeline = mongoPipeline(
			"find t group by g pick g, array_agg(unique x) as u"
		);
		expect(pipeline[0]).toEqual({
			$group: { _id: { g: "$g" }, __agg_0: { $addToSet: "$x" } }
		});
	});

	it("string_agg → $push + $reduce avec sep en $project", () => {
		const pipeline = mongoPipeline(
			`find t group by g pick g, string_agg(name, ", ") as list`
		);
		expect(pipeline[0]).toEqual({
			$group: { _id: { g: "$g" }, __agg_0: { $push: "$name" } }
		});
		const projectStage = pipeline[1] as Record<string, unknown>;
		const list = (projectStage.$project as Record<string, unknown>).list as Record<string, unknown>;
		// $cond wrapper → empty → null, else $reduce
		expect(list.$cond).toBeDefined();
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Runtime KV : collect + sort + string concat
// ═══════════════════════════════════════════════════════════════════════════

describe("runtime KV bucket fold aggregateMulti", () => {
	it("array_agg collecte les values par bucket", () => {
		const rows = [
			{ g: "a", x: 1 },
			{ g: "a", x: 2 },
			{ g: "b", x: 3 }
		];
		const result = kvFold(
			"find t group by g pick g, array_agg(x) as vals",
			rows
		);
		expect(result).toHaveLength(2);
		expect(result).toContainEqual({ g: "a", vals: [1, 2] });
		expect(result).toContainEqual({ g: "b", vals: [3] });
	});

	it("array_agg avec sort intra-call trie les valeurs", () => {
		const rows = [
			{ g: "a", x: 3 },
			{ g: "a", x: 1 },
			{ g: "a", x: 2 }
		];
		const result = kvFold(
			"find t group by g pick g, array_agg(x sort x asc) as vals",
			rows
		);
		expect(result).toEqual([{ g: "a", vals: [1, 2, 3] }]);
	});

	it("array_agg(unique) dédup preserving order", () => {
		const rows = [
			{ g: "a", x: 1 },
			{ g: "a", x: 2 },
			{ g: "a", x: 1 },
			{ g: "a", x: 2 }
		];
		const result = kvFold(
			"find t group by g pick g, array_agg(unique x) as u",
			rows
		);
		expect(result).toEqual([{ g: "a", u: [1, 2] }]);
	});

	it("string_agg concat avec sep + skip NULL", () => {
		const rows = [
			{ g: "a", name: "foo" },
			{ g: "a", name: null },
			{ g: "a", name: "bar" }
		];
		const result = kvFold(
			`find t group by g pick g, string_agg(name, ", ") as list`,
			rows
		);
		expect(result).toEqual([{ g: "a", list: "foo, bar" }]);
	});

	it("string_agg avec sort trie avant concat", () => {
		const rows = [
			{ g: "a", name: "banana" },
			{ g: "a", name: "apple" }
		];
		const result = kvFold(
			`find t group by g pick g, string_agg(name, ", " sort name asc) as list`,
			rows
		);
		expect(result).toEqual([{ g: "a", list: "apple, banana" }]);
	});

	it("json_agg = array_agg côté KV", () => {
		const rows = [
			{ g: "a", v: 1 },
			{ g: "a", v: 2 }
		];
		const result = kvFold(
			"find t group by g pick g, json_agg(v) as arr",
			rows
		);
		expect(result).toEqual([{ g: "a", arr: [1, 2] }]);
	});
});
