/**
 * Sprint T2/11 sub-queries uncorrelated E2E — `in (find ...)` + `exists (find ...)`.
 * Parser + lower + codegen PG (natif) + refus Mongo/KV.
 */

import { describe, expect, it } from "vitest";
import { SnqlError } from "./diagnostics";
import { SNQL_FUNCTIONS } from "./functions";
import { compile, plan, planFor } from "./index";
import { lowerMutation } from "./ir/lower";
import type { Capability } from "./ir/plan";
import { tokenize } from "./lexer/lexer";
import { parse } from "./parser/parser";

const scanOnlyKv = {
	engine: "kv",
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
// Parser : in (find ...) + exists (find ...)
// ═══════════════════════════════════════════════════════════════════════════

describe("parser sub-queries", () => {
	it("where x in (find t pick y) accepté", () => {
		expect(() =>
			pgSql("find u where id in (find t pick user_id)")
		).not.toThrow();
	});

	it("where x in [v1, v2] (value list) toujours accepté (fast-path bracket)", () => {
		expect(() => pgSql(`find u where id in [1, 2, 3]`)).not.toThrow();
	});

	it("exists (find t) accepté", () => {
		expect(() => pgSql(`find u where exists (find t)`)).not.toThrow();
	});

	it("exists sans parens refusé", () => {
		expectCode(
			() => pgSql(`find u where exists name`),
			"parse_exists_missing_paren"
		);
	});

	it("exists (expression scalaire) refusé", () => {
		expectCode(
			() => pgSql(`find u where exists (42)`),
			"parse_exists_not_subquery"
		);
	});

	it("sub-query mutation refusée", () => {
		expectCode(
			() => pgSql(`find u where id in (add {x: 1} into t)`),
			"parse_subquery_not_select"
		);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Lower : validations
// ═══════════════════════════════════════════════════════════════════════════

describe("lower sub-queries", () => {
	it("in (subquery) sans pick refusé", () => {
		expectCode(
			() => pgSql("find u where id in (find t)"),
			"lower_in_subquery_no_pick"
		);
	});

	it("in (subquery) avec pick >1 field refusé", () => {
		expectCode(
			() => pgSql("find u where id in (find t pick a, b)"),
			"lower_in_subquery_arity"
		);
	});

	it("sub-query dans update where refusée", () => {
		// compile() est read-only, on passe par parse + lowerMutation direct.
		const stmt = parse(
			tokenize(`update t where id in (find u pick id) set x = 1`)
		);
		if (stmt.operation !== "update") throw new Error("attendu update");
		expectCode(() => lowerMutation(stmt), "lower_subquery_in_write");
	});

	it("sub-query dans delete where refusée", () => {
		const stmt = parse(tokenize(`remove from t where exists (find u)`));
		if (stmt.operation !== "delete") throw new Error("attendu delete");
		expectCode(() => lowerMutation(stmt), "lower_subquery_in_write");
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Codegen PG : IN (SELECT) / EXISTS (SELECT)
// ═══════════════════════════════════════════════════════════════════════════

describe("codegen PG", () => {
	it("in (find ... pick ...) → IN (SELECT ...)", () => {
		expect(pgSql("find u where id in (find t pick user_id)").text).toBe(
			`SELECT * FROM "u" WHERE "id" IN (SELECT "user_id" FROM "t")`
		);
	});

	it("exists (find ...) → EXISTS (SELECT * FROM ...)", () => {
		expect(pgSql(`find u where exists (find t)`).text).toBe(
			`SELECT * FROM "u" WHERE EXISTS (SELECT * FROM "t")`
		);
	});

	it("sub-query avec where + pick", () => {
		expect(
			pgSql(`find u where id in (find t where active = true pick owner_id)`)
				.text
		).toBe(
			`SELECT * FROM "u" WHERE "id" IN (SELECT "owner_id" FROM "t" WHERE "active" = $1)`
		);
	});

	it("not exists (find ...) → NOT EXISTS", () => {
		expect(pgSql(`find u where not exists (find t)`).text).toBe(
			`SELECT * FROM "u" WHERE (NOT EXISTS (SELECT * FROM "t"))`
		);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Planner : refus Mongo/KV
// ═══════════════════════════════════════════════════════════════════════════

describe("planner Mongo (ADR-024 PM/2 — subquery uncorrelated via matérialisation)", () => {
	it("in (subquery) uncorrelated sur Mongo : accepté au planner (résolution runtime)", () => {
		// PM/2 : Mongo a maintenant 'subquery' capability avec strategy='materialize'.
		// L'uncorrelated passe au planner ; le runtime résout via `materializeSubplan`
		// (packages/engine/src/mongo/materialize.ts, ADR-024 D1) avant codegen final.
		expect(() =>
			planFor("find u where id in (find t pick uid)", "mongodb")
		).not.toThrow();
	});

	it("exists (subquery) uncorrelated sur Mongo : accepté au planner", () => {
		expect(() =>
			planFor("find u where exists (find t)", "mongodb")
		).not.toThrow();
	});

	it("sub-query sur KV (scan-only) refusée (capability 'subquery' absente)", () => {
		const logical = compile("find u where id in (find t pick uid)", {
			engine: "postgres"
		}).plan;
		expectCode(() => plan(logical, scanOnlyKv), "planner_subquery_unsupported");
	});
});
