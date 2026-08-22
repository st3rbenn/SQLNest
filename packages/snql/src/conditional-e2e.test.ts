/**
 * Conditional E2E — lexer + parser + lower + planner + codegen
 * PG/Mongo + runtime KV. Consolide l'ensemble des cas. Couvre `case { … }`
 * + `if/nullif/greatest/least` (fns registre) avec parité cross-engine.
 */

import { describe, expect, it } from "vitest";
import { compensate } from "./runtime/compensate";
import { SnqlError } from "./diagnostics";
import type { Capability } from "./ir/plan";
import { SNQL_FUNCTIONS } from "./functions";
import {
	compile,
	parse,
	plan,
	planFor,
	tokenize
} from "./index";

// Un moteur fictif qui ne sait QUE scanner → tout le reste est compensé.
// Pattern hérité de compensate.test.ts : garantit que la compensation
// exerce vraiment la logique runtime, sans dépendre du pushdown KV.
// On expose l'inventaire de fns KV (SNQL_FUNCTIONS.forEngine("kv")) pour
// que le planner accepte if/nullif/greatest/least (fns dispatchées via
// registry côté runtime, cf. compensate.evalValue → entry.engines.kv).
const scanOnly = {
	engine: "scan-only",
	supports: new Set<Capability>(["scan"]),
	functions: SNQL_FUNCTIONS.forEngine("kv"),
	castTargets: new Set<import("./ir/plan").CastTarget>([
		"int",
		"float",
		"text",
		"bool"
	])
};

function pg(source: string): { text: string; params: readonly unknown[] } {
	const { native } = compile(source, { engine: "postgres" });
	if (native.kind !== "sql") throw new Error("kind sql attendu");
	return { text: native.text, params: native.params };
}

function mongo(source: string): readonly Record<string, unknown>[] {
	const { native } = compile(source, { engine: "mongodb" });
	if (native.kind !== "mongo") throw new Error("kind mongo attendu");
	return native.pipeline;
}

function kv(source: string) {
	// Plan sur scanOnly → tout le pipeline redescend en compensation runtime.
	const logical = compile(source, { engine: "postgres" }).plan;
	return plan(logical, scanOnly);
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
// STEP 1 — Lexer : token `arrow` (`->`)
// ═══════════════════════════════════════════════════════════════════════════

describe("lexer arrow", () => {
	it("`->` adjacent → 1 token", () => {
		const toks = tokenize("a->b");
		expect(toks.map((t) => t.kind)).toEqual(["ident", "arrow", "ident", "eof"]);
	});

	it("`-` seul reste minus", () => {
		expect(tokenize("a - b").map((t) => t.kind)).toEqual([
			"ident",
			"minus",
			"ident",
			"eof"
		]);
	});

	it("`- >` avec espace → 2 tokens", () => {
		expect(tokenize("a - > b").map((t) => t.kind)).toEqual([
			"ident",
			"minus",
			"op",
			"ident",
			"eof"
		]);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// STEP 3 — Parser : soft-keywords case/else, parseCaseBlock
// ═══════════════════════════════════════════════════════════════════════════

describe("parser case", () => {
	it("case bare-key + else obligatoire", () => {
		expect(() =>
			pg('find t pick case { r.n > 0 -> "pos", else -> "neg" } as sign')
		).not.toThrow();
	});

	it("case sans else refusé", () => {
		expectCode(
			() => pg('find t pick case { r.n > 0 -> "pos" } as sign'),
			"parse_case_missing_else"
		);
	});

	it("case sans branche refusé", () => {
		expectCode(
			() => pg('find t pick case { else -> "z" } as sign'),
			"parse_case_no_branches"
		);
	});

	it("arrow manquante refusée", () => {
		expectCode(
			() => pg('find t pick case { r.n > 0 "pos", else -> "z" } as sign'),
			"parse_case_missing_arrow"
		);
	});

	it("else pas en dernier refusé", () => {
		expectCode(
			() =>
				pg(
					'find t pick case { else -> "z", r.n > 0 -> "pos" } as sign'
				),
			"parse_case_else_not_last"
		);
	});

	it("case comme colonne (soft-keyword préservé)", () => {
		expect(() => pg("find t pick case, else")).not.toThrow();
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// STEP 5 — Lower : guards bare/cond/branches
// ═══════════════════════════════════════════════════════════════════════════

describe("lower case guards", () => {
	it("case bare en where refusé", () => {
		expectCode(
			() => pg('find t where case { r.n > 0 -> true, else -> false }'),
			"lower_case_bare_predicate"
		);
	});

	it("case cond littéral non-bool refusé (number)", () => {
		expectCode(
			() => pg('find t pick case { 42 -> "a", else -> "b" } as c'),
			"lower_case_cond_type"
		);
	});

	it("case cond littéral non-bool refusé (string)", () => {
		expectCode(
			() =>
				pg('find t pick case { "hello" -> "a", else -> "b" } as c'),
			"lower_case_cond_type"
		);
	});

	it("case branches types incompatibles refusé", () => {
		expectCode(
			() =>
				pg('find t pick case { r.n > 0 -> 1, else -> "text" } as c'),
			"lower_case_branches_type_mismatch"
		);
	});

	it("case branches compatibles OK (int + int)", () => {
		expect(() =>
			pg('find t pick case { r.n > 0 -> 1, else -> 2 } as c')
		).not.toThrow();
	});

	it("case null polymorphe OK (int + null)", () => {
		expect(() =>
			pg('find t pick case { r.n > 0 -> 1, else -> null } as c')
		).not.toThrow();
	});

	it("if cond littéral non-bool refusé", () => {
		expectCode(
			() => pg('find t pick if(42, "a", "b") as c'),
			"lower_if_cond_type"
		);
	});

	it("if branches types incompatibles refusé", () => {
		expectCode(
			() => pg('find t pick if(r.n > 0, 1, "text") as c'),
			"lower_if_branches_type_mismatch"
		);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// STEP 9 — Codegen PG : CASE WHEN
// ═══════════════════════════════════════════════════════════════════════════

describe("codegen PG case", () => {
	it("case single branch → CASE WHEN … ELSE … END", () => {
		const { text, params } = pg(
			'find t pick case { r.n > 0 -> "pos", else -> "neg" } as sign'
		);
		expect(text).toContain("CASE WHEN");
		expect(text).toContain("ELSE");
		expect(text).toContain("END");
		expect(text).toContain("AS \"sign\"");
		expect(params).toEqual([0, "pos", "neg"]);
	});

	it("case multiple branches → chaîne WHEN", () => {
		const { text } = pg(
			'find t pick case { r.n > 10 -> "big", r.n > 0 -> "small", else -> "zero" } as bucket'
		);
		const whenCount = (text.match(/WHEN/g) ?? []).length;
		expect(whenCount).toBe(2);
	});

	it("if(cond, a, b) → CASE WHEN cond THEN a ELSE b END", () => {
		const { text } = pg('find t pick if(r.n > 0, "pos", "neg") as sign');
		expect(text).toContain("CASE WHEN");
		expect(text).toContain("THEN");
		expect(text).toContain("ELSE");
	});

	it("nullif(a, b) → NULLIF(a, b)", () => {
		const { text } = pg('find t pick nullif(r.status, "") as clean_status');
		expect(text).toContain("NULLIF(");
	});

	it("greatest(a, b, c) → GREATEST(a, b, c)", () => {
		const { text } = pg("find t pick greatest(r.a, r.b, r.c) as m");
		expect(text).toContain("GREATEST(");
	});

	it("least(a, b) → LEAST(a, b)", () => {
		const { text } = pg("find t pick least(r.a, r.b) as m");
		expect(text).toContain("LEAST(");
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// STEP 10 — Codegen Mongo : $switch / $cond / $reduce
// ═══════════════════════════════════════════════════════════════════════════

describe("codegen Mongo case", () => {
	it("case → $switch avec branches + default", () => {
		const pipe = mongo(
			'find t pick case { r.n > 0 -> "pos", else -> "neg" } as sign'
		);
		const project = pipe[pipe.length - 1] as {
			$project: { sign: { $switch: { branches: unknown[]; default: string } } };
		};
		const sw = project.$project.sign.$switch;
		expect(sw.branches).toHaveLength(1);
		expect(sw.default).toBe("neg");
	});

	it("if(cond, a, b) → $cond: [cond, a, b]", () => {
		const pipe = mongo('find t pick if(r.n > 0, "pos", "neg") as sign');
		const project = pipe[pipe.length - 1] as {
			$project: { sign: { $cond: unknown[] } };
		};
		expect(project.$project.sign.$cond).toHaveLength(3);
	});

	it("nullif(a, b) → $cond: [$eq: [a,b], null, a]", () => {
		const pipe = mongo('find t pick nullif(r.status, "") as clean');
		const project = pipe[pipe.length - 1] as {
			$project: { clean: { $cond: unknown[] } };
		};
		expect(project.$project.clean.$cond).toHaveLength(3);
	});

	it("greatest → $reduce NULL-absorb (Option C, PAS $max natif)", () => {
		const pipe = mongo("find t pick greatest(r.a, r.b, r.c) as m");
		const project = pipe[pipe.length - 1] as {
			$project: { m: { $reduce: { input: unknown; initialValue: unknown } } };
		};
		// Absent $max natif — le renderer force l'émulation $reduce parité PG.
		expect(project.$project.m.$reduce).toBeDefined();
	});

	it("least → $reduce NULL-absorb", () => {
		const pipe = mongo("find t pick least(r.a, r.b) as m");
		const project = pipe[pipe.length - 1] as {
			$project: { m: { $reduce: { input: unknown } } };
		};
		expect(project.$project.m.$reduce).toBeDefined();
	});

	it("case bare en where refusé au lower (avant codegen)", () => {
		expectCode(
			() => mongo('find t where case { r.n > 0 -> true, else -> false }'),
			"lower_case_bare_predicate"
		);
	});

	it("case dans compare = true → $expr $switch (via toExprOperand)", () => {
		const pipe = mongo(
			'find t where case { r.n > 0 -> true, else -> false } = true'
		);
		const match = pipe.find((s) => "$match" in s) as {
			$match: { $expr: { $eq: unknown[] } };
		};
		expect(match.$match.$expr).toBeDefined();
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// STEP 11 — Runtime KV : short-circuit + dispatch kv? renderers
// ═══════════════════════════════════════════════════════════════════════════

describe("runtime KV case + registry dispatch", () => {
	it("case short-circuit : première branche true → sa value", () => {
		const p = kv("find t where if(n > 0, true, false) = true");
		const rows = compensate(p.compensation, [
			{ n: 5 },
			{ n: -2 },
			{ n: 0 }
		]);
		expect(rows.map((r) => r.n)).toEqual([5]);
	});

	it("case pick : mapping n → bucket via evalValue case", () => {
		const p = kv(
			'find t pick case { n > 10 -> "big", n > 0 -> "small", else -> "zero" } as bucket'
		);
		const rows = compensate(p.compensation, [{ n: 15 }, { n: 5 }, { n: 0 }]);
		expect(rows.map((r) => r.bucket)).toEqual(["big", "small", "zero"]);
	});

	it("if(cond, then, else) : short-circuit strict === true (null → else)", () => {
		const p = kv("find t pick if(flag, 1, 0) as v");
		const rows = compensate(p.compensation, [
			{ flag: true },
			{ flag: false },
			{ flag: null }
		]);
		expect(rows.map((r) => r.v)).toEqual([1, 0, 0]);
	});

	it("nullif(a, b) : égalité stricte → null", () => {
		const p = kv("find t pick nullif(status, default_status) as clean");
		const rows = compensate(p.compensation, [
			{ status: "active", default_status: "active" },
			{ status: "custom", default_status: "active" }
		]);
		expect(rows.map((r) => r.clean)).toEqual([null, "custom"]);
	});

	it("greatest NULL-absorb parité PG (null dans args → null)", () => {
		const p = kv("find t pick greatest(a, b, c) as m");
		const rows = compensate(p.compensation, [
			{ a: 1, b: 2, c: 3 },
			{ a: 1, b: null, c: 3 },
			{ a: 5, b: 5, c: 5 }
		]);
		expect(rows.map((r) => r.m)).toEqual([3, null, 5]);
	});

	it("least : min NULL-absorb", () => {
		const p = kv("find t pick least(a, b) as m");
		const rows = compensate(p.compensation, [
			{ a: 5, b: 10 },
			{ a: null, b: 3 }
		]);
		expect(rows.map((r) => r.m)).toEqual([5, null]);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// STEP 12 — Language : formatter arrow + block-style
// ═══════════════════════════════════════════════════════════════════════════

describe("formatter case block-style", () => {
	it("case ≥ 3 branches → block-style multi-ligne", async () => {
		const { formatSnql } = await import("./language/format");
		const source =
			'find t pick case { r.n > 10 -> "big", r.n > 0 -> "small", else -> "zero" } as bucket';
		const formatted = formatSnql(source);
		expect(formatted).toContain("\n");
		expect(formatted).toContain("->");
	});

	it("case 2 branches → reste inline", async () => {
		const { formatSnql } = await import("./language/format");
		const source = 'find t pick case { r.n > 0 -> "pos", else -> "neg" } as sign';
		const formatted = formatSnql(source);
		// Pas de newline dans le case (2 items < MULTILINE_MIN_ITEMS).
		expect(formatted).not.toMatch(/case \{\n/);
	});

	it("arrow → espaces autour préservés", async () => {
		const { formatSnql } = await import("./language/format");
		const formatted = formatSnql(
			'find t pick case { r.n>0->"pos",else->"neg" } as s'
		);
		expect(formatted).toContain(" -> ");
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// STEP 13 — Composition cross-engine (case + cast + call)
// ═══════════════════════════════════════════════════════════════════════════

describe("composition case + fns", () => {
	it("case dans un cast (PG)", () => {
		const { text } = pg(
			'find t pick cast(case { r.n > 0 -> 1, else -> 0 } as text) as v'
		);
		expect(text).toContain("CAST(");
		expect(text).toContain("CASE WHEN");
	});

	it("case dans un call (upper(case...))", () => {
		const { text } = pg(
			'find t pick upper(case { r.n > 0 -> "yes", else -> "no" }) as v'
		);
		expect(text).toContain("UPPER(");
		expect(text).toContain("CASE WHEN");
	});

	it("case comparé pour where (case = true)", () => {
		const { text } = pg(
			'find t where case { r.n > 0 -> true, else -> false } = true'
		);
		expect(text).toContain("CASE WHEN");
	});

	it("if imbriqué OK", () => {
		const { text } = pg(
			'find t pick if(r.n > 0, if(r.n > 10, "big", "small"), "zero") as v'
		);
		expect(text).toContain("CASE WHEN");
	});

	it("greatest de calls : greatest(round(r.a), round(r.b)) (PG)", () => {
		const { text } = pg("find t pick greatest(round(r.a), round(r.b)) as m");
		expect(text).toContain("GREATEST(ROUND(");
	});
});
