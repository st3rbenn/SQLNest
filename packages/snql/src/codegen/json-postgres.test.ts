/**
 * Snapshots SQL PG pour les 4 fonctions JSON + planner guards
 * (cast_from_jsonb + json_get_compare_ambiguous) + composition cast + write.
 */

import { describe, expect, it } from "vitest";
import { SnqlError } from "../diagnostics";
import { compile, getMapper, lowerMutation, parse, planFor, tokenize } from "../index";

function sql(source: string): { text: string; params: readonly unknown[] } {
	const { native } = compile(source, { engine: "postgres" });
	if (native.kind !== "sql") throw new Error("kind sql attendu");
	return { text: native.text, params: native.params };
}

function mutation(source: string): { text: string; params: readonly unknown[] } {
	const stmt = parse(tokenize(source));
	if (stmt.operation === "select") throw new Error("mutation attendue");
	const nat = getMapper("postgres").mapMutation(lowerMutation(stmt));
	if (nat.kind !== "sql") throw new Error("kind sql attendu");
	return { text: nat.text, params: nat.params };
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

describe("PG json_get — chain -> + cast per-segment", () => {
	it('json_get(meta, "role") single key', () => {
		expect(sql('find t pick json_get(meta, "role") as r').text).toBe(
			`SELECT ("meta" -> $1::text) AS "r" FROM "t"`
		);
	});

	it('json_get(meta, "a", "b", "c") nested strings', () => {
		expect(sql('find t pick json_get(meta, "a", "b", "c") as x').text).toBe(
			`SELECT ((("meta" -> $1::text) -> $2::text) -> $3::text) AS "x" FROM "t"`
		);
	});

	it("json_get(meta, 'a', 0, 'b') mixed string+int + cast disambigüation", () => {
		expect(sql('find t pick json_get(meta, "items", 0, "name") as n').text).toBe(
			`SELECT ((("meta" -> $1::text) -> $2::int) -> $3::text) AS "n" FROM "t"`
		);
	});

	it("params bindés per-segment (sécurité anti-injection)", () => {
		const { params } = sql('find t pick json_get(meta, "a", 0, "b") as x');
		expect(params).toEqual(["a", 0, "b"]);
	});
});

describe("PG json_get_text — dernier hop ->>", () => {
	it('json_get_text(meta, "a") single key', () => {
		expect(sql('find t pick json_get_text(meta, "a") as x').text).toBe(
			`SELECT ("meta" ->> $1::text) AS "x" FROM "t"`
		);
	});

	it('json_get_text(meta, "a", "b") : ->,->> pattern', () => {
		expect(sql('find t pick json_get_text(meta, "a", "b") as x').text).toBe(
			`SELECT (("meta" -> $1::text) ->> $2::text) AS "x" FROM "t"`
		);
	});
});

describe("PG json_has_key + json_typeof", () => {
	it('json_has_key(meta, "k") → PG ? operator + cast', () => {
		expect(sql('find t pick json_has_key(meta, "k") as h').text).toBe(
			`SELECT ("meta" ? $1::text) AS "h" FROM "t"`
		);
	});

	it("json_typeof(meta) → jsonb_typeof native", () => {
		expect(sql("find t pick json_typeof(meta) as t").text).toBe(
			`SELECT jsonb_typeof("meta") AS "t" FROM "t"`
		);
	});
});

describe("PG planner guards JSON (fail-fast avant 42883)", () => {
	// Ces guards vivent au planner — compile() les court-circuite. On les
	// teste via planFor() qui passe explicitement par le planner.
	it("cast(json_get(x, 'k') as int) → planner_cast_from_jsonb_unsupported", () => {
		try {
			planFor('find t pick cast(json_get(meta, "k") as int) as v', "postgres");
			throw new Error("SnqlError attendu");
		} catch (e) {
			if (!(e instanceof SnqlError)) throw e;
			expect(e.code).toBe("planner_cast_from_jsonb_unsupported");
			expect(e.message).toContain("json_get_text");
		}
	});

	it("where json_get(x, 'k') = 'v' → planner_json_get_compare_ambiguous", () => {
		try {
			planFor('find t where json_get(meta, "k") = "admin"', "postgres");
			throw new Error("SnqlError attendu");
		} catch (e) {
			if (!(e instanceof SnqlError)) throw e;
			expect(e.code).toBe("planner_json_get_compare_ambiguous");
			expect(e.message).toContain("json_get_text");
		}
	});

	it("cast(json_get_text(x, 'k') as int) OK (path recommandé)", () => {
		expect(sql('find t pick cast(json_get_text(meta, "age") as int) as age').text).toBe(
			`SELECT CAST(("meta" ->> $1::text) AS bigint) AS "age" FROM "t"`
		);
	});

	it("where json_get_text(x, 'k') = 'v' OK", () => {
		const { text, params } = sql('find t where json_get_text(meta, "role") = "admin"');
		expect(text).toBe(
			`SELECT * FROM "t" WHERE ("meta" ->> $1::text) = $2`
		);
		expect(params).toEqual(["role", "admin"]);
	});
});

describe("PG JSON en write (autorisé si hoistable)", () => {
	it("update SET label = json_get_text(meta, 'name') passe", () => {
		expect(
			mutation('update t where id = 1 set label = json_get_text(meta, "name")').text
		).toBe(
			`UPDATE "t" SET "label" = ("meta" ->> $1::text) WHERE "id" = $2 RETURNING *`
		);
	});

	it("update where json_has_key(meta, 'k') = true passe", () => {
		// $1 = y=1 (SET), $2 = 'k' (has_key key), $3 = true.
		const { text } = mutation('update t where json_has_key(meta, "k") = true set y = 1');
		expect(text).toContain(`("meta" ? $2::text)`);
	});

	it("remove from t where json_has_key(meta, 'archived') = true passe", () => {
		const { text } = mutation('remove from t where json_has_key(meta, "archived") = true');
		expect(text).toContain(`DELETE FROM "t" WHERE ("meta" ? $1::text)`);
	});
});
