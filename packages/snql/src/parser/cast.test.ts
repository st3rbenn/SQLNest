import { describe, expect, it } from "vitest";
import { SnqlError } from "../diagnostics";
import { tokenize } from "../lexer/lexer";
import type { Expr, Query } from "./ast";
import { parse } from "./parser";

function ast(source: string): Query {
	return parse(tokenize(source));
}

function pickField(source: string, idx = 0) {
	const q = ast(source);
	const pick = q.stages.find((s) => s.type === "pick");
	if (pick === undefined || pick.type !== "pick") {
		throw new Error("pick stage attendu");
	}
	return pick.fields[idx];
}

function pickExpr(source: string, idx = 0): Expr {
	const f = pickField(source, idx);
	if (f?.expr === undefined) {
		throw new Error("field.expr attendu");
	}
	return f.expr;
}

function whereExpr(source: string): Expr {
	const q = ast(source);
	const where = q.stages.find((s) => s.type === "where");
	if (where === undefined || where.type !== "where") {
		throw new Error("where stage attendu");
	}
	return where.predicate;
}

describe("parser cast — surface et targets", () => {
	it("parse cast(x as int)", () => {
		const expr = pickExpr("get t pick cast(x as int) as x_int");
		expect(expr).toMatchObject({
			type: "cast",
			target: "int",
			operand: { type: "field", path: ["x"] }
		});
	});

	it("les 7 targets canoniques parsent", () => {
		for (const t of [
			"int",
			"float",
			"text",
			"bool",
			"date",
			"timestamp",
			"json"
		]) {
			const expr = pickExpr(`get t pick cast(x as ${t}) as y`);
			expect(expr).toMatchObject({ type: "cast", target: t });
		}
	});

	it("nom cast case-insensitive (CAST/Cast)", () => {
		expect(pickExpr("get t pick CAST(x as int) as y")).toMatchObject({
			type: "cast",
			target: "int"
		});
		expect(pickExpr("get t pick Cast(x as int) as y")).toMatchObject({
			type: "cast",
			target: "int"
		});
	});

	it("target case-insensitive (INT/Int)", () => {
		expect(pickExpr("get t pick cast(x as INT) as y")).toMatchObject({
			target: "int"
		});
		expect(pickExpr("get t pick cast(x as Int) as y")).toMatchObject({
			target: "int"
		});
	});

	it("cast d'un chemin pointé", () => {
		const expr = pickExpr("get users as u pick cast(u.email as text) as e");
		expect(expr).toMatchObject({
			type: "cast",
			target: "text",
			operand: { type: "field", path: ["u", "email"] }
		});
	});

	it("cast d'une arith", () => {
		const expr = pickExpr("get t pick cast(a + b as float) as sum");
		expect(expr).toMatchObject({
			type: "cast",
			target: "float",
			operand: { type: "arith", operator: "+" }
		});
	});

	it("cast d'un call", () => {
		const expr = pickExpr("get t pick cast(now() as date) as today");
		expect(expr).toMatchObject({
			type: "cast",
			target: "date",
			operand: { type: "call", name: "now" }
		});
	});

	it("cast imbriqué", () => {
		const expr = pickExpr(
			"get t pick cast(cast(raw as text) as int) as normalized"
		);
		expect(expr).toMatchObject({
			type: "cast",
			target: "int",
			operand: {
				type: "cast",
				target: "text",
				operand: { type: "field", path: ["raw"] }
			}
		});
	});

	it("cast en position where (compare)", () => {
		const expr = whereExpr('get t where cast(created_at as date) = "2026-01-01"');
		expect(expr).toMatchObject({
			type: "compare",
			operator: "=",
			left: { type: "cast", target: "date" }
		});
	});

	it("compat pick alias : le second `as` reste à parseFieldSelection", () => {
		const f = pickField("get t pick cast(x as int) as x_int");
		expect(f).toMatchObject({
			alias: "x_int",
			expr: { type: "cast", target: "int" }
		});
	});
});

describe("parser cast — cast reste ident valide hors position `cast(`", () => {
	it("colonne nommée cast en pick", () => {
		const q = ast("get t pick cast, other");
		const pick = q.stages.find((s) => s.type === "pick");
		if (pick?.type !== "pick") throw new Error("pick attendu");
		expect(pick.fields[0]).toMatchObject({ path: ["cast"] });
		expect(pick.fields[1]).toMatchObject({ path: ["other"] });
	});

	it("colonne nommée cast en where compare", () => {
		const expr = whereExpr("get t where cast > 100");
		expect(expr).toMatchObject({
			type: "compare",
			left: { type: "field", path: ["cast"] }
		});
	});
});

describe("parser cast — erreurs typées", () => {
	function fails(source: string, code: string): void {
		try {
			ast(source);
			throw new Error(`attendu SnqlError avec code=${code}, aucune levée`);
		} catch (e) {
			if (!(e instanceof SnqlError)) throw e;
			expect(e.code).toBe(code);
		}
	}

	it("cast() → parse_cast_empty", () => {
		fails("get t pick cast() as y", "parse_cast_empty");
	});

	it("cast(x) → parse_cast_missing_as", () => {
		fails("get t pick cast(x) as y", "parse_cast_missing_as");
	});

	it("cast(x, y) → parse_cast_comma_before_as (message dédié)", () => {
		fails("get t pick cast(x, y) as z", "parse_cast_comma_before_as");
	});

	it("cast(x as ) → parse_cast_target_expected", () => {
		fails("get t pick cast(x as ) as y", "parse_cast_target_expected");
	});

	it('cast(x as "int") → parse_cast_target_expected (pas de string)', () => {
		fails('get t pick cast(x as "int") as y', "parse_cast_target_expected");
	});

	it("cast(x as 42) → parse_cast_target_expected", () => {
		fails("get t pick cast(x as 42) as y", "parse_cast_target_expected");
	});

	// Enum/2b : le parser accepte tout ident lowercase comme target — le lower
	// tranche (builtin CAST_TARGETS ou enum-ref via schema.enums). Ces alias
	// SQL non-canoniques (decimal/integer/string) sont refusés au lower, pas
	// au parser. Tests migrés dans lower.test.ts au niveau `lower_cast_unknown_target`.
	it("cast(x as decimal) est accepté au parser (lower décide)", () => {
		expect(() => ast("get t pick cast(x as decimal) as y")).not.toThrow();
	});

	it("cast(x as integer) est accepté au parser (lower décide)", () => {
		expect(() => ast("get t pick cast(x as integer) as y")).not.toThrow();
	});

	it("cast(x as string) est accepté au parser (lower décide)", () => {
		expect(() => ast("get t pick cast(x as string) as y")).not.toThrow();
	});

	it("cast(x as int, y) → parse_cast_extra_args", () => {
		fails("get t pick cast(x as int, y) as z", "parse_cast_extra_args");
	});
});
