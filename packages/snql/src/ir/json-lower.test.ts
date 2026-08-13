/**
 * Guards lower JSON (sprint 4) : 11 codes d'erreur × edge cases + reserved
 * lexemes + bool_bare_predicate cross-engine.
 */

import { describe, expect, it } from "vitest";
import { SnqlError } from "../diagnostics";
import { compile, tokenize } from "../index";
import { parse } from "../parser/parser";
import { lowerMutation } from "./lower";

function expectCode(fn: () => unknown, code: string): void {
	try {
		fn();
		throw new Error(`SnqlError attendu avec code=${code}`);
	} catch (e) {
		if (!(e instanceof SnqlError)) throw e;
		expect(e.code).toBe(code);
	}
}

describe("json path guards — variadic segments", () => {
	it("json_get(doc) sans segment → lower_call_arity ou path_empty", () => {
		// arity min=2 attrapé avant path_empty ; les 2 sont acceptables.
		try {
			compile("find t pick json_get(meta) as x", { engine: "postgres" });
			throw new Error("SnqlError attendu");
		} catch (e) {
			if (!(e instanceof SnqlError)) throw e;
			expect(["lower_call_arity", "lower_call_json_path_empty"]).toContain(
				e.code
			);
		}
	});

	it("json_get(doc, dynamic_col) → lower_call_json_path_dynamic_segment", () => {
		expectCode(
			() => compile("find t pick json_get(meta, other_col) as x", { engine: "postgres" }),
			"lower_call_json_path_dynamic_segment"
		);
	});

	it("json_get(doc, 1.5) segment float → lower_call_json_path_invalid_segment_type", () => {
		expectCode(
			() => compile("find t pick json_get(meta, 1.5) as x", { engine: "postgres" }),
			"lower_call_json_path_invalid_segment_type"
		);
	});

	it("json_get(doc, -1) segment négatif → lower_call_json_path_negative_index", () => {
		expectCode(
			() => compile("find t pick json_get(meta, -1) as x", { engine: "postgres" }),
			"lower_call_json_path_negative_index"
		);
	});

	it("json_get(doc, 3000000000) segment > INT32_MAX → lower_call_json_path_int_overflow", () => {
		expectCode(
			() => compile("find t pick json_get(meta, 3000000000) as x", { engine: "postgres" }),
			"lower_call_json_path_int_overflow"
		);
	});

	it('json_get(doc, "") segment string vide → lower_call_json_path_empty_segment', () => {
		expectCode(
			() => compile('find t pick json_get(meta, "") as x', { engine: "postgres" }),
			"lower_call_json_path_empty_segment"
		);
	});

	it("json_get_text hérite tous les guards", () => {
		expectCode(
			() => compile("find t pick json_get_text(meta, other_col) as x", { engine: "postgres" }),
			"lower_call_json_path_dynamic_segment"
		);
	});

	it("json_get(doc, 'a', 0, 'b') segments mixés OK", () => {
		expect(() =>
			compile('find t pick json_get(meta, "a", 0, "b") as x', { engine: "postgres" })
		).not.toThrow();
	});
});

describe("json_has_key guards", () => {
	it("json_has_key(doc, dynamic) → lower_call_json_has_key_dynamic_key", () => {
		expectCode(
			() =>
				compile("find t pick json_has_key(meta, key_col) as k", {
					engine: "postgres"
				}),
			"lower_call_json_has_key_dynamic_key"
		);
	});

	it('json_has_key(doc, "") → lower_call_json_has_key_empty_key', () => {
		expectCode(
			() => compile('find t pick json_has_key(meta, "") as k', { engine: "postgres" }),
			"lower_call_json_has_key_empty_key"
		);
	});

	it('json_has_key(doc, "k") OK', () => {
		expect(() =>
			compile('find t pick json_has_key(meta, "k") as k', { engine: "postgres" })
		).not.toThrow();
	});
});

describe("bool_bare_predicate cross-engine", () => {
	it("where json_has_key(doc, 'k') bare → lower_call_bool_bare_predicate", () => {
		expectCode(
			() => compile('find t where json_has_key(meta, "k")', { engine: "postgres" }),
			"lower_call_bool_bare_predicate"
		);
	});

	it("même code côté Mongo (rejet cross-engine)", () => {
		expectCode(
			() => compile('find t where json_has_key(meta, "k")', { engine: "mongodb" }),
			"lower_call_bool_bare_predicate"
		);
	});

	it("wrapper compare = true passe", () => {
		expect(() =>
			compile('find t where json_has_key(meta, "k") = true', { engine: "postgres" })
		).not.toThrow();
	});

	it("aussi en mutation write predicate", () => {
		const stmt = parse(tokenize('update t where json_has_key(meta, "k") set y = 1'));
		if (stmt.operation !== "update") throw new Error("update attendu");
		expectCode(() => lowerMutation(stmt), "lower_call_bool_bare_predicate");
	});
});

describe("reserved lexemes JSON sprint 4", () => {
	const reserved = [
		// json_contains DÉBLOQUÉ sprint object-literals (PG only) — retiré des reserved.
		"json_set",
		"json_delete",
		"json_merge",
		"json_path",
		"json_array_length",
		"json_length",
		"json_object_keys"
	];
	for (const name of reserved) {
		it(`${name}(...) → lower_call_reserved avec hint sprint 5+`, () => {
			try {
				compile(`find t pick ${name}(meta, "x") as v`, { engine: "postgres" });
				throw new Error("SnqlError attendu");
			} catch (e) {
				if (!(e instanceof SnqlError)) throw e;
				expect(e.code).toBe("lower_call_reserved");
				expect(e.message).toContain(name);
				expect(e.message.toLowerCase()).toContain("sprint");
			}
		});
	}
});
