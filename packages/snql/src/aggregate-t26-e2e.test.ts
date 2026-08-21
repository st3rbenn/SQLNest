/**
 * Sprint T2/6 Aggregates E2E — lexer + parser + lower + planner + codegen
 * PG/Mongo + runtime KV. Corpus `count / sum / avg / min / max` + `count(*)`
 * + modifier `unique`. Parité cross-engine + refus positions non-agg.
 */

import { describe, expect, it } from "vitest";
import { compensate } from "./runtime/compensate";
import { SnqlError } from "./diagnostics";
import { lowerMutation } from "./ir/lower";
import type { Capability } from "./ir/plan";
import { SNQL_FUNCTIONS } from "./functions";
import { tokenize } from "./lexer/lexer";
import { parse } from "./parser/parser";
import { compile, plan } from "./index";

// Moteur "scan-only" — force le pipeline entier à passer en compensation KV.
// Réutilise le pattern conditional-t25-e2e.test.ts : exercice réel du runtime.
// Sprint T2/6 : PAS de 'aggregate' dans supports → l'aggregate op passe en
// compensation runtime KV (foldAggregate).
const scanOnly = {
	engine: "scan-only",
	supports: new Set<Capability>(["scan"]),
	functions: SNQL_FUNCTIONS.forEngine("kv"),
	castTargets: new Set<import("./ir/plan").CastTarget>([
		"int",
		"float",
		"text",
		"bool"
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
// STEP 4 — Parser : star + unique fast-paths
// ═══════════════════════════════════════════════════════════════════════════

describe("parser fast-paths", () => {
	it("count(*) accepté", () => {
		expect(() => pgSql("find u pick count(*) as n")).not.toThrow();
	});

	it("sum(*) refusé — star réservé count", () => {
		expectCode(
			() => pgSql("find u pick sum(*) as n"),
			"parse_call_star_only_count"
		);
	});

	it("count(*, x) refusé — star arg unique", () => {
		expectCode(
			() => pgSql("find u pick count(*, x) as n"),
			"parse_call_star_with_extra_args"
		);
	});

	it("count(unique x) accepté", () => {
		expect(() => pgSql("find u pick count(unique x) as n")).not.toThrow();
	});

	it("count(unique u.email) accepté", () => {
		expect(() =>
			pgSql("find u pick count(unique u.email) as n")
		).not.toThrow();
	});

	it("count(distinct x) refusé — hint utilise unique", () => {
		expectCode(
			() => pgSql("find u pick count(distinct x) as n"),
			"parse_call_distinct_use_unique"
		);
	});

	it("count(unique) nu refusé — piège UX", () => {
		expectCode(
			() => pgSql("find u pick count(unique) as n"),
			"parse_call_unique_missing_arg"
		);
	});

	it("count(unique x, y) refusé — arité mono-arg", () => {
		expectCode(
			() => pgSql("find u pick count(unique x, y) as n"),
			"parse_call_unique_extra_args"
		);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// STEP 5 — Lower call-level guards
// ═══════════════════════════════════════════════════════════════════════════

describe("lower call-level", () => {
	it("count() nu (0 args, sans star) refusé", () => {
		expectCode(
			() => pgSql("find u pick count() as n"),
			"lower_call_count_missing_arg"
		);
	});

	it("min(unique x) refusé — no-op explicite", () => {
		expectCode(
			() => pgSql("find u pick min(unique x) as m"),
			"lower_call_unique_no_op_min_max"
		);
	});

	it("max(unique x) refusé — no-op explicite", () => {
		expectCode(
			() => pgSql("find u pick max(unique x) as m"),
			"lower_call_unique_no_op_min_max"
		);
	});

	it("upper(unique x) refusé — modifier aggregate-only", () => {
		expectCode(
			() => pgSql("find u pick upper(unique name) as u"),
			"lower_call_unique_aggregate_only"
		);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// STEP 6 — Refus positions non-agg (walker)
// ═══════════════════════════════════════════════════════════════════════════

describe("lower refus positions non-agg", () => {
	it("where count(x) > 0 → lower_agg_in_where", () => {
		expectCode(
			() => pgSql("find u where count(id) > 0 pick name"),
			"lower_agg_in_where"
		);
	});

	it("update set y = count(*) → lower_agg_in_set (avant call_null_write)", () => {
		expectCode(() => {
			const stmt = parse(tokenize("update t set y = count(*)"));
			if (stmt.operation !== "update") throw new Error("update attendu");
			lowerMutation(stmt);
		}, "lower_agg_in_set");
	});

	it("delete from t where sum(x) > 100 → lower_agg_in_delete_predicate", () => {
		expectCode(() => {
			const stmt = parse(tokenize("remove from t where sum(x) > 100"));
			if (stmt.operation !== "delete") throw new Error("delete attendu");
			lowerMutation(stmt);
		}, "lower_agg_in_delete_predicate");
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// STEP 7 — Lower op='aggregate' + wrapping validation
// ═══════════════════════════════════════════════════════════════════════════

describe("lower op='aggregate' + wrappers", () => {
	it("pick sum(x) as s → wrap en op='aggregate'", () => {
		const logical = compile("find t pick sum(x) as s", {
			engine: "postgres"
		}).plan;
		// Le project root est aggregate.
		expect(logical.op).toBe("aggregate");
	});

	it("pick r.id, count(*) → planner_agg_bare_field_needs_group", () => {
		expectCode(
			() => pgSql("find r pick r.id, count(*) as n"),
			"planner_agg_bare_field_needs_group"
		);
	});

	it("if(status='paid', sum(x), 0) → bare field 'status' hors agg", () => {
		expectCode(
			() =>
				pgSql(
					"find o pick if(status = \"paid\", sum(amount), 0) as safe"
				),
			"lower_bare_field_in_agg_scalar_wrapper"
		);
	});

	it("if(count(*)>0, avg(x), 0) → agg in if cond", () => {
		expectCode(
			() =>
				pgSql("find o pick if(count(*) > 0, avg(amount), 0) as avg_or_zero"),
			"lower_agg_in_if_cond"
		);
	});

	it("sum(count(x)) → agg nested", () => {
		expectCode(
			() => pgSql("find o pick sum(count(id)) as n"),
			"lower_agg_nested"
		);
	});

	it("coalesce(sum(x), 0) autorisé (scalar-around-agg)", () => {
		expect(() =>
			pgSql("find o pick coalesce(sum(amount), 0) as safe_sum")
		).not.toThrow();
	});

	it("greatest(max(price), 1000) autorisé (composition T2/5 + T2/6)", () => {
		expect(() =>
			pgSql("find p pick greatest(max(price), 1000) as ceiling")
		).not.toThrow();
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// STEP 9 — Codegen PG
// ═══════════════════════════════════════════════════════════════════════════

describe("codegen PG", () => {
	it("count(*) → COUNT(*)", () => {
		expect(pgSql("find u pick count(*) as n").text).toBe(
			`SELECT COUNT(*) AS "n" FROM "u"`
		);
	});

	it("count(x) → COUNT(x)", () => {
		expect(pgSql("find u pick count(email) as with_email").text).toBe(
			`SELECT COUNT("email") AS "with_email" FROM "u"`
		);
	});

	it("count(unique x) → COUNT(DISTINCT x)", () => {
		expect(
			pgSql("find u pick count(unique email) as distinct_emails").text
		).toBe(`SELECT COUNT(DISTINCT "email") AS "distinct_emails" FROM "u"`);
	});

	it("sum(x) → SUM(x)::double precision", () => {
		expect(pgSql("find o pick sum(amount) as revenue").text).toBe(
			`SELECT SUM("amount")::double precision AS "revenue" FROM "o"`
		);
	});

	it("avg(x) → AVG(x)::double precision", () => {
		expect(pgSql("find o pick avg(amount) as ticket").text).toBe(
			`SELECT AVG("amount")::double precision AS "ticket" FROM "o"`
		);
	});

	it("min/max passthrough sans cast", () => {
		const q = pgSql(
			"find o pick min(created_at) as first, max(created_at) as last"
		).text;
		expect(q).toContain(`MIN("created_at") AS "first"`);
		expect(q).toContain(`MAX("created_at") AS "last"`);
	});

	it("where + agg → WHERE hoisté avant agg", () => {
		const q = pgSql(
			`find o where status = "paid" pick count(*) as n`
		).text;
		expect(q).toBe(
			`SELECT COUNT(*) AS "n" FROM "o" WHERE "status" = $1`
		);
	});

	it("coalesce(sum(x), 0) → COALESCE(SUM(x)::double precision, $1)", () => {
		const q = pgSql(
			"find o pick coalesce(sum(amount), 0) as safe_sum"
		).text;
		expect(q).toContain(`COALESCE(SUM("amount")::double precision`);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// STEP 10 — Codegen Mongo (SSA extract + $group/$project)
// ═══════════════════════════════════════════════════════════════════════════

describe("codegen Mongo", () => {
	it("count(*) → $group{_id:null,__agg_0:{$sum:1}} + $project rename", () => {
		const pipe = mongoPipeline("find u pick count(*) as n");
		expect(pipe).toEqual([
			{ $group: { _id: null, __agg_0: { $sum: 1 } } },
			{ $project: { _id: 0, n: "$__agg_0" } }
		]);
	});

	it("count(x) NULL-ignore via $cond", () => {
		const pipe = mongoPipeline("find u pick count(email) as n");
		expect(pipe[0]).toEqual({
			$group: {
				_id: null,
				__agg_0: { $sum: { $cond: [{ $ne: ["$email", null] }, 1, 0] } }
			}
		});
	});

	it("count(unique x) 2-stage $addToSet + $size", () => {
		const pipe = mongoPipeline("find u pick count(unique email) as n");
		expect(pipe[0]).toEqual({
			$group: {
				_id: null,
				__u_0: {
					$addToSet: {
						$cond: [{ $ne: ["$email", null] }, "$email", "$$REMOVE"]
					}
				}
			}
		});
		expect(pipe[1]).toEqual({
			$project: { _id: 0, n: { $size: "$__u_0" } }
		});
	});

	it("sum/avg/min/max → accumulators natifs", () => {
		const pipe = mongoPipeline(
			"find o pick sum(amount) as s, avg(amount) as a, min(created) as mn, max(created) as mx"
		);
		expect(pipe[0]).toEqual({
			$group: {
				_id: null,
				__agg_0: { $sum: "$amount" },
				__agg_1: { $avg: "$amount" },
				__agg_2: { $min: "$created" },
				__agg_3: { $max: "$created" }
			}
		});
	});

	it("SSA déduplication : sum(x) as a, sum(x) as b → 1 slot partagé", () => {
		const pipe = mongoPipeline(
			"find o pick sum(amount) as a, sum(amount) as b"
		);
		expect(pipe[0]).toEqual({
			$group: { _id: null, __agg_0: { $sum: "$amount" } }
		});
		expect(pipe[1]).toEqual({
			$project: { _id: 0, a: "$__agg_0", b: "$__agg_0" }
		});
	});

	it("scalar-around-agg : coalesce(sum(x), 0) → SSA slot + wrapper", () => {
		const pipe = mongoPipeline(
			"find o pick coalesce(sum(amount), 0) as safe_sum"
		);
		expect(pipe[0]).toEqual({
			$group: { _id: null, __agg_0: { $sum: "$amount" } }
		});
		// coalesce → $ifNull chained (mongoCoalesce implementation)
		expect(pipe[1]).toMatchObject({ $project: { _id: 0 } });
		// safe_sum contient un wrapper qui référence $__agg_0
		const proj = pipe[1] as { $project: Record<string, unknown> };
		expect(JSON.stringify(proj.$project.safe_sum)).toContain("$__agg_0");
	});

	it("sum(unique x) sur Mongo → SSA slot $addToSet + $sum (ADR-024 PM/6 #5)", () => {
		const pipeline = mongoPipeline("find o pick sum(unique amount) as s");
		const groupStage = pipeline.find((s) => "$group" in s) as {
			$group: Record<string, unknown>;
		};
		// Slot uSet contient $addToSet (dédup non-null via $$REMOVE)
		const uSlot = Object.keys(groupStage.$group).find((k) =>
			k.startsWith("__u_")
		);
		expect(uSlot).toBeDefined();
		expect(groupStage.$group[uSlot!]).toEqual({
			$addToSet: {
				$cond: [{ $ne: ["$amount", null] }, "$amount", "$$REMOVE"]
			}
		});
		// Le project pick le slot via $sum sur le set
		const projectStage = pipeline.find((s) => "$project" in s) as {
			$project: Record<string, unknown>;
		};
		expect(projectStage.$project.s).toEqual({ $sum: `$${uSlot!}` });
	});

	it("avg(unique x) sur Mongo → SSA slot $addToSet + $avg (ADR-024 PM/6 #5)", () => {
		const pipeline = mongoPipeline("find o pick avg(unique amount) as a");
		const projectStage = pipeline.find((s) => "$project" in s) as {
			$project: Record<string, unknown>;
		};
		const groupStage = pipeline.find((s) => "$group" in s) as {
			$group: Record<string, unknown>;
		};
		const uSlot = Object.keys(groupStage.$group).find((k) =>
			k.startsWith("__u_")
		);
		expect(projectStage.$project.a).toEqual({ $avg: `$${uSlot!}` });
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// STEP 11 — Runtime KV (fold + scalar-around-agg)
// ═══════════════════════════════════════════════════════════════════════════

describe("runtime KV fold", () => {
	const rows = [
		{ id: 1, amount: 10, email: "a@x", status: "paid" },
		{ id: 2, amount: 20, email: "b@x", status: "paid" },
		{ id: 3, amount: null, email: null, status: "cancelled" },
		{ id: 4, amount: 30, email: "a@x", status: "paid" }
	];

	it("count(*) → 4 rows", () => {
		expect(kvFold("find r pick count(*) as n", rows)).toEqual([{ n: 4 }]);
	});

	it("count(email) NULL-ignore → 3", () => {
		expect(kvFold("find r pick count(email) as n", rows)).toEqual([{ n: 3 }]);
	});

	it("count(unique email) → 2 (a@x, b@x)", () => {
		expect(kvFold("find r pick count(unique email) as n", rows)).toEqual([
			{ n: 2 }
		]);
	});

	it("sum(amount) NULL-ignore → 60", () => {
		expect(kvFold("find r pick sum(amount) as s", rows)).toEqual([{ s: 60 }]);
	});

	it("avg(amount) → 20 (60/3)", () => {
		expect(kvFold("find r pick avg(amount) as a", rows)).toEqual([{ a: 20 }]);
	});

	it("min/max(amount) NULL-ignore", () => {
		expect(
			kvFold("find r pick min(amount) as mn, max(amount) as mx", rows)
		).toEqual([{ mn: 10, mx: 30 }]);
	});

	it("empty collection : sum/avg → null, count → 0", () => {
		expect(
			kvFold(
				"find r pick count(*) as n, sum(amount) as s, avg(amount) as a",
				[]
			)
		).toEqual([{ n: 0, s: null, a: null }]);
	});

	it("scalar-around-agg : coalesce(sum(x), 0) sur empty → 0", () => {
		expect(
			kvFold("find r pick coalesce(sum(amount), 0) as safe", [])
		).toEqual([{ safe: 0 }]);
	});
});
