import { describe, expect, it } from "vitest";
import { SnqlError } from "../diagnostics";
import { tokenize } from "../lexer/lexer";
import { parse } from "../parser/parser";
import { lower, lowerMutation } from "./lower";
import type { LogicalPlan, PlanExpr } from "./plan";

function firstFilter(plan: LogicalPlan): PlanExpr {
	let p = plan;
	while (p.op !== "filter") {
		if (p.op === "scan") throw new Error("filter absent");
		p = p.input;
	}
	return p.predicate;
}

function firstPickExpr(plan: LogicalPlan): PlanExpr {
	let p = plan;
	while (p.op !== "project") {
		if (p.op === "scan") throw new Error("project absent");
		p = p.input;
	}
	const field = p.fields[0];
	if (field?.expr === undefined) throw new Error("field.expr attendu");
	return field.expr;
}

describe("lower cast — round-trip AST → IR", () => {
	for (const t of [
		"int",
		"float",
		"text",
		"bool",
		"date",
		"timestamp",
		"json"
	] as const) {
		it(`preserve target ${t}`, () => {
			const stmt = parse(tokenize(`get t pick cast(x as ${t}) as y`));
			if (stmt.operation !== "select") throw new Error("select attendu");
			const plan = lower(stmt);
			expect(firstPickExpr(plan)).toMatchObject({ kind: "cast", target: t });
		});
	}

	it("cast imbriqué descend récursivement", () => {
		const stmt = parse(
			tokenize("get t pick cast(cast(raw as text) as int) as n")
		);
		if (stmt.operation !== "select") throw new Error("select attendu");
		const plan = lower(stmt);
		expect(firstPickExpr(plan)).toMatchObject({
			kind: "cast",
			target: "int",
			operand: {
				kind: "cast",
				target: "text",
				operand: { kind: "field", path: ["raw"] }
			}
		});
	});

	it("span porté = span de l'operand (targeting PG 22P02)", () => {
		const src = "get t pick cast(x as int) as y";
		const stmt = parse(tokenize(src));
		if (stmt.operation !== "select") throw new Error("select attendu");
		const plan = lower(stmt);
		const cast = firstPickExpr(plan);
		if (cast.kind !== "cast") throw new Error("cast attendu");
		// L'operand est le field `x` — le span doit pointer sur `x`, pas sur `cast(`.
		expect(cast.operand.span).toBeDefined();
		expect(cast.span).toEqual(cast.operand.span);
	});

	it("cast dans WHERE (predicate)", () => {
		const stmt = parse(
			tokenize('get t where cast(created_at as date) = "2026-01-01"')
		);
		if (stmt.operation !== "select") throw new Error("select attendu");
		const plan = lower(stmt);
		const pred = firstFilter(plan);
		expect(pred).toMatchObject({
			kind: "compare",
			op: "eq",
			left: { kind: "cast", target: "date" }
		});
	});
});

describe("lower cast — autorisé en write (déterministe + NULL propagate)", () => {
	it("update SET value = cast(x as int) passe assertNoCallInWrite", () => {
		const stmt = parse(
			tokenize("update t where id = 1 set y = cast(x as int)")
		);
		if (stmt.operation !== "update") throw new Error("update attendu");
		expect(() => lowerMutation(stmt)).not.toThrow();
	});

	it("update WHERE cast(x as int) > 30 set active = true passe", () => {
		const stmt = parse(
			tokenize("update t where cast(age as int) > 30 set active = true")
		);
		if (stmt.operation !== "update") throw new Error("update attendu");
		expect(() => lowerMutation(stmt)).not.toThrow();
	});

	it("remove from t where cast(x as int) = 42 passe", () => {
		const stmt = parse(
			tokenize("remove from t where cast(x as int) = 42")
		);
		if (stmt.operation !== "delete") throw new Error("delete attendu");
		expect(() => lowerMutation(stmt)).not.toThrow();
	});
});

describe("lower cast — call sous cast reste refusé récursivement", () => {
	it("set y = cast(upper(name) as text) → lower_call_null_write sur upper", () => {
		const stmt = parse(
			tokenize("update t where id = 1 set y = cast(upper(name) as text)")
		);
		if (stmt.operation !== "update") throw new Error("update attendu");
		try {
			lowerMutation(stmt);
			throw new Error("SnqlError attendu");
		} catch (e) {
			if (!(e instanceof SnqlError)) throw e;
			expect(e.code).toBe("lower_call_null_write");
			expect(e.message).toContain("upper");
		}
	});

	it("update where cast(round(x) as int) = 0 refusé (round dans predicate)", () => {
		const stmt = parse(
			tokenize("update t where cast(round(x) as int) = 0 set y = 1")
		);
		if (stmt.operation !== "update") throw new Error("update attendu");
		try {
			lowerMutation(stmt);
			throw new Error("SnqlError attendu");
		} catch (e) {
			if (!(e instanceof SnqlError)) throw e;
			expect(e.code).toBe("lower_call_null_write");
		}
	});
});

describe("lower cast — insert values restent literal-only", () => {
	it("add {price: cast(raw as float)} into t → refusé literalOf", () => {
		const stmt = parse(
			tokenize("add {price: cast(raw as float)} into t")
		);
		if (stmt.operation !== "insert") throw new Error("insert attendu");
		expect(() => lowerMutation(stmt)).toThrow(/literal|littéral/i);
	});
});
