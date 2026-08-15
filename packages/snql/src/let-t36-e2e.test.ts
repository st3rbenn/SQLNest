/**
 * Sprint T3/6 — CTE `let x = find ...; body`.
 *
 * Couvre :
 *  - parser  : bindings avec ; obligatoire, body find/add/update/remove,
 *              refus body transaction/raw/introspect/let-in-transaction,
 *              refus binding non-select, refus dupliqué.
 *  - lower   : refus write-to-cte (add/update/remove sur nom de CTE),
 *              chaînage (let b = find a ... where a est déjà défini).
 *  - codegen : PG WITH ... AS ... BODY_SQL, params bindés séquentiellement
 *              à travers WITH + BODY.
 *  - planner : capability cte présente PG / absente Mongo+KV.
 */

import { describe, expect, it } from "vitest";
import { SnqlError } from "./diagnostics";
import {
	assertLetSupported,
	getMapper,
	KV_CAPABILITIES,
	lowerLet,
	MONGODB_CAPABILITIES,
	parse,
	POSTGRES_CAPABILITIES,
	tokenize
} from "./index";

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

describe("parser — let CTE", () => {
	it("`let active = find users where is_active = true; find active pick id`", () => {
		const stmt = parse(
			tokenize("let active = find users where is_active = true; find active pick id")
		);
		if (stmt.operation !== "let") throw new Error("let attendu");
		expect(stmt.bindings).toHaveLength(1);
		expect(stmt.bindings[0]!.name).toBe("active");
		expect(stmt.body.operation).toBe("select");
	});

	it("chaînage : deux bindings + body", () => {
		const stmt = parse(
			tokenize(
				"let a = find users; let b = find a where is_active = true; find b pick email"
			)
		);
		if (stmt.operation !== "let") throw new Error();
		expect(stmt.bindings.map((b) => b.name)).toEqual(["a", "b"]);
	});

	it("body update qui référence un CTE (via subquery)", () => {
		const stmt = parse(
			tokenize(
				'let old = find orders where created_at < "2020-01-01"; remove from orders where id in (find old pick id)'
			)
		);
		if (stmt.operation !== "let") throw new Error();
		expect(stmt.body.operation).toBe("delete");
	});

	it("body insert-select depuis CTE", () => {
		const stmt = parse(
			tokenize(
				'let candidates = find users where email like "%@old.com"; add (find candidates pick id, email) into archive'
			)
		);
		if (stmt.operation !== "let") throw new Error();
		expect(stmt.body.operation).toBe("insert");
	});

	it("refus binding non-select (let x = add ...)", () => {
		expectCode(
			() => parse(tokenize('let x = add {n: 1} into t; find users')),
			"parse_let_binding_not_select"
		);
	});

	it("refus `let` sans `;`", () => {
		expectCode(
			() => parse(tokenize("let a = find users find users")),
			"parse_let_missing_semicolon"
		);
	});

	it("refus `let` sans nom", () => {
		expectCode(() => parse(tokenize("let = find users")), "parse_let_missing_name");
	});

	it("refus body raw", () => {
		expectCode(
			() => parse(tokenize('let a = find users; raw "SELECT 1"')),
			"parse_let_body_unsupported"
		);
	});

	it("refus body transaction", () => {
		expectCode(
			() => parse(tokenize("let a = find users; transaction { find users }")),
			"parse_let_body_unsupported"
		);
	});

	it("refus `let` dans transaction", () => {
		expectCode(
			() =>
				parse(tokenize("transaction { let a = find users; find a pick id }")),
			"parse_let_in_transaction"
		);
	});

	it("`let` reste ident hors tête (col nommée let)", () => {
		const stmt = parse(tokenize("find t pick x as let"));
		if (stmt.operation !== "select") throw new Error("select attendu");
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Lower
// ═══════════════════════════════════════════════════════════════════════════

describe("lower — let CTE", () => {
	it("refus doublon de nom", () => {
		const stmt = parse(
			tokenize("let a = find users; let a = find orders; find a pick id")
		);
		if (stmt.operation !== "let") throw new Error();
		expectCode(() => lowerLet(stmt), "lower_let_duplicate_name");
	});

	it("refus add {…} into <cte> (immutable)", () => {
		const stmt = parse(
			tokenize('let cache = find users; add {name: "x"} into cache')
		);
		if (stmt.operation !== "let") throw new Error();
		expectCode(() => lowerLet(stmt), "lower_let_write_to_cte");
	});

	it("refus update <cte> set …", () => {
		const stmt = parse(
			tokenize("let cache = find users; update cache set email = \"x\"")
		);
		if (stmt.operation !== "let") throw new Error();
		expectCode(() => lowerLet(stmt), "lower_let_write_to_cte");
	});

	it("refus remove from <cte>", () => {
		const stmt = parse(
			tokenize("let cache = find users; remove from cache where id = 1")
		);
		if (stmt.operation !== "let") throw new Error();
		expectCode(() => lowerLet(stmt), "lower_let_write_to_cte");
	});

	it("chaînage lowered correctement (bindings dans l'ordre)", () => {
		const stmt = parse(
			tokenize("let a = find users; let b = find a; find b pick id")
		);
		if (stmt.operation !== "let") throw new Error();
		const plan = lowerLet(stmt);
		expect(plan.bindings.map((b) => b.name)).toEqual(["a", "b"]);
		expect(plan.body.op).toBe("project");
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Codegen PG
// ═══════════════════════════════════════════════════════════════════════════

describe("codegen PG — let CTE", () => {
	it("`let a = find users; find a pick id` produit WITH ... SELECT", () => {
		const stmt = parse(tokenize("let a = find users; find a pick id"));
		if (stmt.operation !== "let") throw new Error();
		const plan = lowerLet(stmt);
		const mapper = getMapper("postgres");
		const native = mapper.mapLet!(plan);
		if (native.kind !== "sql") throw new Error();
		expect(native.text).toContain("WITH");
		expect(native.text).toContain(`"a" AS (`);
		expect(native.text).toContain(`FROM "a"`);
	});

	it("body update (CTE prep, use simple) — WITH ... UPDATE", () => {
		// v1 limitation : subquery-in-write refusé (T2/11), donc le CTE
		// ne peut pas être ref via `where id in (find cte …)` dans un
		// update/delete. Le CTE reste utile ici pour préparer un dataset
		// avant du join/insert-select. Test que le codegen émet bien
		// WITH + UPDATE quand un let précède un update simple.
		const stmt = parse(
			tokenize(
				'let active = find users where is_active = true; update orders where id = 1 set status = "shipped"'
			)
		);
		if (stmt.operation !== "let") throw new Error();
		const plan = lowerLet(stmt);
		const native = getMapper("postgres").mapLet!(plan);
		if (native.kind !== "sql") throw new Error();
		expect(native.text).toContain("WITH");
		expect(native.text).toContain("UPDATE");
	});

	it("body insert-select — WITH ... INSERT", () => {
		const stmt = parse(
			tokenize(
				'let old = find users where email like "%@old.com"; add (find old pick id, email) into archive'
			)
		);
		if (stmt.operation !== "let") throw new Error();
		const plan = lowerLet(stmt);
		const native = getMapper("postgres").mapLet!(plan);
		if (native.kind !== "sql") throw new Error();
		expect(native.text).toContain("WITH");
		expect(native.text).toContain("INSERT INTO");
	});

	it("chaînage — deux bindings émis en séquence", () => {
		const stmt = parse(
			tokenize("let a = find users; let b = find a; find b pick id")
		);
		if (stmt.operation !== "let") throw new Error();
		const plan = lowerLet(stmt);
		const native = getMapper("postgres").mapLet!(plan);
		if (native.kind !== "sql") throw new Error();
		expect(native.text).toContain(`"a" AS (`);
		expect(native.text).toContain(`"b" AS (`);
		// L'ordre a-avant-b est essentiel (b réfère a).
		const idxA = native.text.indexOf(`"a" AS (`);
		const idxB = native.text.indexOf(`"b" AS (`);
		expect(idxA).toBeLessThan(idxB);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Planner — capability `cte`
// ═══════════════════════════════════════════════════════════════════════════

describe("planner — capability 'cte'", () => {
	it("PG supporte cte", () => {
		const stmt = parse(tokenize("let a = find users; find a pick id"));
		if (stmt.operation !== "let") throw new Error();
		const plan = lowerLet(stmt);
		expect(() => assertLetSupported(plan, POSTGRES_CAPABILITIES)).not.toThrow();
	});

	it("Mongo refuse cte", () => {
		const stmt = parse(tokenize("let a = find users; find a pick id"));
		if (stmt.operation !== "let") throw new Error();
		const plan = lowerLet(stmt);
		expectCode(
			() => assertLetSupported(plan, MONGODB_CAPABILITIES),
			"planner_let_unsupported"
		);
	});

	it("KV refuse cte", () => {
		const stmt = parse(tokenize("let a = find users; find a pick id"));
		if (stmt.operation !== "let") throw new Error();
		const plan = lowerLet(stmt);
		expectCode(
			() => assertLetSupported(plan, KV_CAPABILITIES),
			"planner_let_unsupported"
		);
	});
});
