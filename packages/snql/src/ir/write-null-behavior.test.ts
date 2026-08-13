/**
 * Verrouille la politique NullBehavior en contexte write (sprint 3). Chaque
 * fonction déclarée avec writeNullBehavior est autorisée en update SET /
 * update WHERE / remove WHERE ; celles non déclarées restent refusées.
 */

import { describe, expect, it } from "vitest";
import { SnqlError } from "../diagnostics";
import { lowerMutation } from "./lower";
import { tokenize } from "../lexer/lexer";
import { parse } from "../parser/parser";

function tryLower(source: string): void {
	const stmt = parse(tokenize(source));
	if (stmt.operation === "select") throw new Error("mutation attendue");
	lowerMutation(stmt);
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

describe("writeNullBehavior — fonctions `propagate` autorisées en write", () => {
	const propagateCases: [string, string][] = [
		["upper (sprint 1)", "update t where id = 1 set y = upper(x)"],
		["lower (sprint 1)", "update t where id = 1 set y = lower(x)"],
		["length (sprint 1)", "update t where id = 1 set y = length(x)"],
		["abs (sprint 1)", "update t where id = 1 set y = abs(x)"],
		["round (sprint 1)", "update t where id = 1 set y = round(x)"],
		["trim (sprint 3)", "update t where id = 1 set y = trim(x)"],
		["ltrim (sprint 3)", "update t where id = 1 set y = ltrim(x)"],
		["rtrim (sprint 3)", "update t where id = 1 set y = rtrim(x)"],
		["substring (sprint 3)", "update t where id = 1 set y = substring(x, 1, 5)"],
		["replace (sprint 3)", 'update t where id = 1 set y = replace(x, "a", "b")'],
		["strpos (sprint 3)", 'update t where id = 1 set y = strpos(x, "a")'],
		["floor (sprint 3)", "update t where id = 1 set y = floor(x)"],
		["ceil (sprint 3)", "update t where id = 1 set y = ceil(x)"],
		["date_part (sprint 3)", 'update t where id = 1 set y = date_part("year", created)'],
		["date_trunc (sprint 3)", 'update t where id = 1 set y = date_trunc("day", created)'],
		["date_add (sprint 3)", 'update t where id = 1 set y = date_add("day", created, 1)'],
		["date_diff (sprint 3)", 'update t where id = 1 set y = date_diff("day", end_dt, start_dt)']
	];
	for (const [label, source] of propagateCases) {
		it(`${label} passe en write`, () => {
			expect(() => tryLower(source)).not.toThrow();
		});
	}
});

describe("writeNullBehavior — fonctions déterministes / custom autorisées", () => {
	it("now() (deterministic) passe en write", () => {
		expect(() =>
			tryLower("update t where id = 1 set updated = now()")
		).not.toThrow();
	});

	it("today() (deterministic) passe en write", () => {
		expect(() =>
			tryLower("update t where id = 1 set day = today()")
		).not.toThrow();
	});

	it("coalesce(a, b) (custom) passe en write", () => {
		expect(() =>
			tryLower('update t where id = 1 set y = coalesce(a, "default")')
		).not.toThrow();
	});
});

describe("writeNullBehavior — concat reste REFUSÉ (divergence PG/Mongo non résolue)", () => {
	it("update set y = concat(a, b) → lower_call_null_write", () => {
		expectCode(
			() => tryLower('update t where id = 1 set y = concat(a, "-", b)'),
			"lower_call_null_write"
		);
	});

	it("message mentionne 'sémantique NULL non déclarée'", () => {
		try {
			tryLower('update t where id = 1 set y = concat(a, b)');
		} catch (e) {
			if (!(e instanceof SnqlError)) throw e;
			expect(e.message).toContain("sémantique NULL non déclarée");
		}
	});
});

describe("writeNullBehavior — call en position WHERE de write", () => {
	it("update where upper(x) = 'X' passe", () => {
		expect(() =>
			tryLower('update t where upper(x) = "X" set y = 1')
		).not.toThrow();
	});

	it("remove from t where trim(email) = '' passe", () => {
		expect(() =>
			tryLower('remove from t where trim(email) = ""')
		).not.toThrow();
	});

	it("update where concat(a, b) = 'x' refusé (concat non déclaré)", () => {
		expectCode(
			() => tryLower('update t where concat(a, b) = "x" set y = 1'),
			"lower_call_null_write"
		);
	});
});

describe("writeNullBehavior — récursion : call safe wrap call non-safe", () => {
	it("set y = upper(concat(a, b)) refusé (concat en profondeur)", () => {
		expectCode(
			() => tryLower("update t where id = 1 set y = upper(concat(a, b))"),
			"lower_call_null_write"
		);
	});

	it("set y = cast(concat(a, b) as text) refusé (concat sous cast)", () => {
		expectCode(
			() => tryLower("update t where id = 1 set y = cast(concat(a, b) as text)"),
			"lower_call_null_write"
		);
	});
});
