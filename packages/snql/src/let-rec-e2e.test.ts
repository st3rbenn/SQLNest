/**
 * CTE récursif `let rec X = base union all step; body`.
 *
 * Couvre :
 *  - parser  : mot-clé contextuel `rec` après `let`, syntaxe `base union all
 *              step`, refus `union` seul, refus deux `union all`, refus
 *              `union all` détaché hors let rec.
 *  - lower   : refus base self-ref, refus step sans self-ref, `pick`
 *              obligatoire sur base et step, refus `find <rec_cte>` body
 *              sans `limit N` (garde-fou OOM).
 *  - codegen : PG `WITH RECURSIVE name AS ((base) UNION ALL (step)) BODY`
 *              avec parens explicites autour de chaque membre.
 */

import { describe, expect, it } from "vitest";
import { SnqlError } from "./diagnostics";
import {
	assertLetSupported,
	getMapper,
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

const ORG_CHART = `
let rec org_chart =
	find employee where reports_to = null pick employee_id, first_name
	union all
	find employee as e with one org_chart as o on e.reports_to = o.employee_id
		pick e.employee_id, e.first_name
;
find org_chart pick employee_id, first_name limit 100
`;

// ═══════════════════════════════════════════════════════════════════════════
// Parser
// ═══════════════════════════════════════════════════════════════════════════

describe("parser — let rec", () => {
	it("canonique org_chart parse en LetStatement { kind: 'recursive' }", () => {
		const stmt = parse(tokenize(ORG_CHART));
		if (stmt.operation !== "let") throw new Error("let attendu");
		expect(stmt.bindings).toHaveLength(1);
		const b = stmt.bindings[0]!;
		expect(b.kind).toBe("recursive");
		if (b.kind !== "recursive") throw new Error();
		expect(b.name).toBe("org_chart");
		expect(b.base.operation).toBe("select");
		expect(b.step.operation).toBe("select");
	});

	it("refus `union` seul (dedup coûteuse punt v-next)", () => {
		expectCode(
			() =>
				parse(
					tokenize(
						"let rec r = find t pick id union find t pick id; find r limit 1"
					)
				),
			"parse_let_rec_union_needs_all"
		);
	});

	it("refus deux `union all` (branches multiples punt v-next)", () => {
		expectCode(
			() =>
				parse(
					tokenize(
						"let rec r = find t pick id union all find r pick id union all find r pick id; find r limit 1"
					)
				),
			"parse_let_rec_multiple_union_all"
		);
	});

	it("refus `union all` détaché hors let rec", () => {
		expectCode(
			() => parse(tokenize("find users pick id union all find orders pick id")),
			"parse_union_all_outside_let_rec"
		);
	});

	it("refus `let rec = ...` (CTE nommée `rec` réservée)", () => {
		expectCode(
			() => parse(tokenize("let rec = find users; find users")),
			"parse_let_rec_reserved_name"
		);
	});

	it("plain `let x = find …;` reste valide (kind: 'plain')", () => {
		const stmt = parse(
			tokenize("let x = find users; find x pick email")
		);
		if (stmt.operation !== "let") throw new Error();
		expect(stmt.bindings[0]!.kind).toBe("plain");
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Lower
// ═══════════════════════════════════════════════════════════════════════════

describe("lower — let rec", () => {
	it("canonique produit un PlanCteBinding { kind: 'recursive' }", () => {
		const stmt = parse(tokenize(ORG_CHART));
		if (stmt.operation !== "let") throw new Error();
		const plan = lowerLet(stmt);
		expect(plan.bindings).toHaveLength(1);
		expect(plan.bindings[0]!.kind).toBe("recursive");
	});

	it("refus base self-reference (non terminable)", () => {
		expectCode(() => {
			const stmt = parse(
				tokenize(
					"let rec r = find r pick id union all find r pick id; find r limit 1"
				)
			);
			if (stmt.operation !== "let") throw new Error();
			lowerLet(stmt);
		}, "lower_let_rec_base_self_reference");
	});

	it("refus step sans self-reference (utilise `let` simple)", () => {
		expectCode(() => {
			const stmt = parse(
				tokenize(
					"let rec r = find employee pick id union all find department pick id; find r limit 1"
				)
			);
			if (stmt.operation !== "let") throw new Error();
			lowerLet(stmt);
		}, "lower_let_rec_step_no_self_reference");
	});

	it("refus base sans `pick` (shape indéfinie)", () => {
		expectCode(() => {
			const stmt = parse(
				tokenize(
					"let rec r = find t union all find r pick id; find r limit 1"
				)
			);
			if (stmt.operation !== "let") throw new Error();
			lowerLet(stmt);
		}, "lower_let_rec_pick_required");
	});

	it("refus step sans `pick`", () => {
		expectCode(() => {
			const stmt = parse(
				tokenize(
					"let rec r = find t pick id union all find r; find r limit 1"
				)
			);
			if (stmt.operation !== "let") throw new Error();
			lowerLet(stmt);
		}, "lower_let_rec_pick_required");
	});

	it("refus body `find <rec_cte>` sans `limit N` (garde-fou OOM)", () => {
		expectCode(() => {
			const stmt = parse(
				tokenize(
					"let rec r = find t pick id union all find r pick id; find r pick id"
				)
			);
			if (stmt.operation !== "let") throw new Error();
			lowerLet(stmt);
		}, "lower_let_rec_body_unbounded");
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Codegen PG
// ═══════════════════════════════════════════════════════════════════════════

describe("codegen PG — WITH RECURSIVE", () => {
	it("émet `WITH RECURSIVE name AS ((base) UNION ALL (step)) body`", () => {
		const stmt = parse(tokenize(ORG_CHART));
		if (stmt.operation !== "let") throw new Error();
		const plan = lowerLet(stmt);
		const pg = getMapper("postgres");
		const q = pg.mapLet(plan);
		expect(q.kind).toBe("sql");
		if (q.kind !== "sql") throw new Error();
		expect(q.text).toMatch(/WITH RECURSIVE/);
		expect(q.text).toMatch(/"org_chart" AS \(\(SELECT/);
		expect(q.text).toMatch(/\) UNION ALL \(SELECT/);
	});

	it("plain `let x = ...;` reste `WITH …` (pas RECURSIVE) — non-regression", () => {
		const stmt = parse(
			tokenize("let x = find users pick id; find x pick id limit 10")
		);
		if (stmt.operation !== "let") throw new Error();
		const plan = lowerLet(stmt);
		const pg = getMapper("postgres");
		const q = pg.mapLet(plan);
		if (q.kind !== "sql") throw new Error();
		expect(q.text).toMatch(/^WITH /);
		expect(q.text).not.toMatch(/WITH RECURSIVE/);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Planner — capability cte-recursive
// ═══════════════════════════════════════════════════════════════════════════

describe("planner — cte-recursive capability", () => {
	it("PG passe `assertLetSupported` sur let rec", () => {
		const stmt = parse(tokenize(ORG_CHART));
		if (stmt.operation !== "let") throw new Error();
		const plan = lowerLet(stmt);
		expect(() => assertLetSupported(plan, POSTGRES_CAPABILITIES)).not.toThrow();
	});

	it("Mongo refuse un let rec (matérialisation récursion trop coûteuse)", () => {
		const stmt = parse(tokenize(ORG_CHART));
		if (stmt.operation !== "let") throw new Error();
		const plan = lowerLet(stmt);
		expectCode(
			() => assertLetSupported(plan, MONGODB_CAPABILITIES),
			"planner_let_rec_unsupported"
		);
	});

	it("plain let x reste supporté Mongo (non-regression)", () => {
		const stmt = parse(
			tokenize("let x = find users pick id; find x pick id limit 10")
		);
		if (stmt.operation !== "let") throw new Error();
		const plan = lowerLet(stmt);
		expect(() => assertLetSupported(plan, MONGODB_CAPABILITIES)).not.toThrow();
	});
});
