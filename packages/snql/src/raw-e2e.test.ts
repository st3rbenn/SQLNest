/**
 * Escape hatch `raw "SQL"` / `raw {...}`.
 *
 * Couvre :
 *  - parser  : `raw "..."` (SQL) et `raw {...}` (Mongo command) ; refus
 *              sans payload ; refus dans transaction.
 *  - lower   : RawPlan pass-through.
 *  - codegen : PG accepte sql / refuse object ; Mongo accepte object /
 *              refuse sql ; object non-literal refusé (aucune ref field/call).
 */

import { describe, expect, it } from "vitest";
import { SnqlError } from "./diagnostics";
import { getMapper, lowerRaw, parse, tokenize } from "./index";

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
// Parser
// ═══════════════════════════════════════════════════════════════════════════

describe("parser — raw", () => {
	it("`raw \"SELECT 1\"` — payload SQL", () => {
		const stmt = parse(tokenize('raw "SELECT 1"'));
		if (stmt.operation !== "raw") throw new Error("raw attendu");
		if (stmt.payload.kind !== "sql") throw new Error("sql attendu");
		expect(stmt.payload.text).toBe("SELECT 1");
	});

	it("`raw {aggregate: \"users\"}` — payload Mongo", () => {
		const stmt = parse(tokenize('raw {aggregate: "users"}'));
		if (stmt.operation !== "raw") throw new Error();
		if (stmt.payload.kind !== "mongo") throw new Error("mongo attendu");
		expect(stmt.payload.command.type).toBe("object");
	});

	it("refus `raw` sans payload", () => {
		expectCode(() => parse(tokenize("raw")), "parse_raw_missing_payload");
	});

	it("refus `raw` dans transaction", () => {
		expectCode(
			() => parse(tokenize('transaction { raw "SELECT 1" }')),
			"parse_raw_in_transaction"
		);
	});

	it("`raw` reste ident hors tête (col nommée raw)", () => {
		const stmt = parse(tokenize("find t pick x as raw"));
		if (stmt.operation !== "select") throw new Error("select attendu");
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Codegen PG
// ═══════════════════════════════════════════════════════════════════════════

describe("codegen PG — raw", () => {
	it("`raw \"SELECT ...\"` produit SqlQuery text-only", () => {
		const stmt = parse(tokenize('raw "SELECT * FROM users WHERE id = 1"'));
		if (stmt.operation !== "raw") throw new Error();
		const planned = lowerRaw(stmt);
		const mapper = getMapper("postgres");
		const native = mapper.mapRaw!(planned);
		if (native.kind !== "sql") throw new Error();
		expect(native.text).toBe("SELECT * FROM users WHERE id = 1");
		expect(native.params).toEqual([]);
	});

	it("`raw {...}` refusé sur PG (cross-shape)", () => {
		const stmt = parse(tokenize('raw {aggregate: "users"}'));
		if (stmt.operation !== "raw") throw new Error();
		const planned = lowerRaw(stmt);
		const mapper = getMapper("postgres");
		expectCode(() => mapper.mapRaw!(planned), "codegen_raw_shape_mismatch");
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Codegen Mongo
// ═══════════════════════════════════════════════════════════════════════════

describe("codegen Mongo — raw", () => {
	it("`raw {aggregate: \"users\", pipeline: []}` produit mongo-raw", () => {
		const stmt = parse(tokenize('raw {aggregate: "users", pipeline: []}'));
		if (stmt.operation !== "raw") throw new Error();
		const planned = lowerRaw(stmt);
		const mapper = getMapper("mongodb");
		const native = mapper.mapRaw!(planned);
		if (native.kind !== "mongo-raw") throw new Error();
		expect(native.command).toEqual({ aggregate: "users", pipeline: [] });
	});

	it("`raw \"...\"` refusé sur Mongo (cross-shape)", () => {
		const stmt = parse(tokenize('raw "SELECT 1"'));
		if (stmt.operation !== "raw") throw new Error();
		const planned = lowerRaw(stmt);
		const mapper = getMapper("mongodb");
		expectCode(() => mapper.mapRaw!(planned), "codegen_raw_shape_mismatch");
	});

	it("literals numeric/bool/string/nested préservés", () => {
		const stmt = parse(
			tokenize('raw {n: 42, s: "hi", b: true, nested: {k: 1}, arr: [1, 2]}')
		);
		if (stmt.operation !== "raw") throw new Error();
		const planned = lowerRaw(stmt);
		const native = getMapper("mongodb").mapRaw!(planned);
		if (native.kind !== "mongo-raw") throw new Error();
		expect(native.command).toEqual({
			n: 42,
			s: "hi",
			b: true,
			nested: { k: 1 },
			arr: [1, 2]
		});
	});

	it("keys avec `$` acceptées (operators Mongo natifs)", () => {
		// Cas fréquent : raw {aggregate: "u", pipeline: [{$count: "n"}]} —
		// le lexer doit tokeniser $count comme ident (opérateur Mongo natif).
		const stmt = parse(
			tokenize('raw {aggregate: "users", pipeline: [{$count: "n"}]}')
		);
		if (stmt.operation !== "raw") throw new Error();
		const planned = lowerRaw(stmt);
		const native = getMapper("mongodb").mapRaw!(planned);
		if (native.kind !== "mongo-raw") throw new Error();
		expect(native.command).toEqual({
			aggregate: "users",
			pipeline: [{ $count: "n" }]
		});
	});

	it("field ref dans un raw Mongo refusé (non-literal)", () => {
		const stmt = parse(tokenize("raw {filter: some_col}"));
		if (stmt.operation !== "raw") throw new Error();
		const planned = lowerRaw(stmt);
		expectCode(
			() => getMapper("mongodb").mapRaw!(planned),
			"codegen_raw_non_literal"
		);
	});
});
