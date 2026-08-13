import { describe, expect, it } from "vitest";
import { SnqlError } from "../diagnostics";
import { lower, tokenize } from "../index";
import { parse } from "../parser/parser";
import { compensate } from "./compensate";
import type { CompensationOp } from "../planner/planner";

/** Utilitaire : compile un select en compensation `filter` seule pour tester
 *  l'évaluation d'un cast dans un prédicat (les compensations sont KV-only). */
function filterPred(source: string): CompensationOp {
	const stmt = parse(tokenize(source));
	if (stmt.operation !== "select") throw new Error("select attendu");
	const plan = lower(stmt);
	if (plan.op !== "filter") throw new Error("filter attendu au sommet");
	return { op: "filter", predicate: plan.predicate };
}

/** Extrait la valeur d'un cast(x as T) évalué sur une row (via un pick). */
function evalCast(source: string, row: Record<string, unknown>): unknown {
	const stmt = parse(tokenize(source));
	if (stmt.operation !== "select") throw new Error("select attendu");
	const plan = lower(stmt);
	if (plan.op !== "project") throw new Error("project attendu");
	const projectOp: CompensationOp = { op: "project", fields: plan.fields };
	const [projected] = compensate([projectOp], [row]);
	return projected?.["y"];
}

describe("runtime KV compensate — cast int", () => {
	it('cast("42" as int) → 42', () => {
		expect(evalCast("get t pick cast(x as int) as y", { x: "42" })).toBe(42);
	});

	it('cast("42.7" as int) → 42 (trunc)', () => {
		expect(evalCast("get t pick cast(x as int) as y", { x: "42.7" })).toBe(42);
	});

	it('cast("abc" as int) → runtime_cast_invalid', () => {
		try {
			evalCast("get t pick cast(x as int) as y", { x: "abc" });
			throw new Error("SnqlError attendu");
		} catch (e) {
			if (!(e instanceof SnqlError)) throw e;
			expect(e.code).toBe("runtime_cast_invalid");
		}
	});
});

describe("runtime KV compensate — cast float", () => {
	it('cast("1.5" as float) → 1.5', () => {
		expect(evalCast("get t pick cast(x as float) as y", { x: "1.5" })).toBe(
			1.5
		);
	});

	it('cast("abc" as float) → runtime_cast_invalid', () => {
		try {
			evalCast("get t pick cast(x as float) as y", { x: "abc" });
			throw new Error("SnqlError attendu");
		} catch (e) {
			if (!(e instanceof SnqlError)) throw e;
			expect(e.code).toBe("runtime_cast_invalid");
		}
	});
});

describe("runtime KV compensate — cast text", () => {
	it("cast(42 as text) → '42'", () => {
		expect(evalCast("get t pick cast(x as text) as y", { x: 42 })).toBe("42");
	});

	it("cast(true as text) → 'true'", () => {
		expect(evalCast("get t pick cast(x as text) as y", { x: true })).toBe(
			"true"
		);
	});
});

describe("runtime KV compensate — cast bool STRICT (parité PG)", () => {
	it("cast(true as bool) → true", () => {
		expect(evalCast("get t pick cast(x as bool) as y", { x: true })).toBe(
			true
		);
	});

	it("cast(false as bool) → false", () => {
		expect(evalCast("get t pick cast(x as bool) as y", { x: false })).toBe(
			false
		);
	});

	it('cast("true" as bool) → runtime_cast_invalid (PAS truthy JS)', () => {
		// Divergence délibérée vs Mongo BSON $convert (truthy) — voir spec
		// mongo=`cast bool` divergence documentée. Runtime KV suit PG strict.
		try {
			evalCast("get t pick cast(x as bool) as y", { x: "true" });
			throw new Error("SnqlError attendu");
		} catch (e) {
			if (!(e instanceof SnqlError)) throw e;
			expect(e.code).toBe("runtime_cast_invalid");
		}
	});

	it("cast(1 as bool) → runtime_cast_invalid (pas truthy JS)", () => {
		try {
			evalCast("get t pick cast(x as bool) as y", { x: 1 });
			throw new Error("SnqlError attendu");
		} catch (e) {
			if (!(e instanceof SnqlError)) throw e;
			expect(e.code).toBe("runtime_cast_invalid");
		}
	});
});

describe("runtime KV compensate — NULL propagate", () => {
	it("cast(null as int) → null (pas throw)", () => {
		expect(evalCast("get t pick cast(x as int) as y", { x: null })).toBe(null);
	});

	it("cast(undefined as int) → null (missing field, pas throw)", () => {
		// x absent de la row → undefined → null.
		expect(evalCast("get t pick cast(x as int) as y", {})).toBe(null);
	});

	it("cast(null as text) → null (propagate)", () => {
		expect(evalCast("get t pick cast(x as text) as y", { x: null })).toBe(
			null
		);
	});
});

describe("runtime KV compensate — cast en position filter (predicate)", () => {
	it("filter cast(x as int) > 30 accepte les rows où x = '42'", () => {
		const op = filterPred("get t where cast(x as int) > 30");
		const out = compensate([op], [{ x: "42" }, { x: "10" }, { x: null }]);
		// x=42 → 42>30 true, x=10 → 10>30 false, x=null → cast=null → 3VL null → false.
		expect(out).toEqual([{ x: "42" }]);
	});
});
