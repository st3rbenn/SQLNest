import { describe, expect, it } from "vitest";
import { compile, lowerMutation, parse, tokenize } from "../index";
import { checkArity, describeArity } from "./arity";
import { SNQL_FUNCTIONS, createRegistry, type FunctionEntry } from "./index";

describe("call node — registry + arity", () => {
	it("SNQL_FUNCTIONS contient les 20 builtins (sprint 1 + 3) + 1 reserved", () => {
		expect(SNQL_FUNCTIONS.names()).toEqual(
			new Set([
				// sprint 1
				"upper",
				"lower",
				"length",
				"abs",
				"round",
				"coalesce",
				"now",
				"concat",
				// sprint 3 string
				"trim",
				"ltrim",
				"rtrim",
				"substring",
				"replace",
				"strpos",
				// sprint 3 number
				"floor",
				"ceil",
				// sprint 3 date
				"today",
				"date_part",
				"date_trunc",
				"date_add",
				"date_diff",
				// sprint 3 reserved
				"regex_replace"
			])
		);
	});

	it("forEngine expose les fonctions supportées par engine (21 mappées + 1 reserved sans engine)", () => {
		// 8 sprint 1 + 13 sprint 3 mappées = 21 ; regex_replace reserved
		// n'a pas de renderer → absent de forEngine.
		expect(SNQL_FUNCTIONS.forEngine("postgres").size).toBe(21);
		expect(SNQL_FUNCTIONS.forEngine("mongodb").size).toBe(21);
		expect(SNQL_FUNCTIONS.forEngine("kv").size).toBe(0);
	});

	it("createRegistry(base, overrides) écrase par nom", () => {
		const dummy: FunctionEntry = {
			name: "upper",
			kind: "scalar",
			arity: { min: 1, max: 1 },
			engines: { postgres: () => "CUSTOM_UPPER" }
		};
		const reg = createRegistry([...SNQL_FUNCTIONS.names()].map((n) => SNQL_FUNCTIONS.get(n) as FunctionEntry), [dummy]);
		expect(reg.get("upper")?.engines.postgres?.([], { renderExpr: () => "" })).toBe(
			"CUSTOM_UPPER"
		);
	});

	it("checkArity — arité fixe", () => {
		expect(checkArity("upper", { min: 1, max: 1 }, 1)).toBeNull();
		expect(checkArity("upper", { min: 1, max: 1 }, 0)).toContain("1 argument");
		expect(checkArity("upper", { min: 1, max: 1 }, 2)).toContain("1 argument");
	});

	it("checkArity — range", () => {
		expect(checkArity("round", { min: 1, max: 2 }, 1)).toBeNull();
		expect(checkArity("round", { min: 1, max: 2 }, 2)).toBeNull();
		expect(checkArity("round", { min: 1, max: 2 }, 3)).toContain("1 ou 2");
	});

	it("checkArity — variadic non borné", () => {
		expect(checkArity("concat", { min: 1, max: null }, 1)).toBeNull();
		expect(checkArity("concat", { min: 1, max: null }, 50)).toBeNull();
		expect(checkArity("concat", { min: 1, max: null }, 0)).toContain("au moins 1");
	});

	it("describeArity — messages FR", () => {
		expect(describeArity({ min: 1, max: 1 })).toBe("1 argument");
		expect(describeArity({ min: 2, max: 2 })).toBe("2 arguments");
		expect(describeArity({ min: 1, max: 2 })).toBe("1 ou 2 arguments");
		expect(describeArity({ min: 1, max: 5 })).toBe("entre 1 et 5 arguments");
		expect(describeArity({ min: 2, max: null })).toBe("au moins 2 arguments");
	});
});

describe("call node — parser + lower + codegen PG", () => {
	function sqlOf(src: string): string {
		const { native } = compile(src, { engine: "postgres" });
		if (native.kind !== "sql") throw new Error("attendu sql");
		return native.text;
	}

	it("call scalaire dans pick avec alias", () => {
		expect(sqlOf("find users pick upper(name) as u")).toBe(
			`SELECT UPPER("name") AS "u" FROM "users"`
		);
	});

	it("call à 0 arg : now()", () => {
		expect(sqlOf("find events pick timestamp, now() as t")).toBe(
			`SELECT "timestamp", NOW() AS "t" FROM "events"`
		);
	});

	it("call variadic : coalesce(a, b, c)", () => {
		expect(sqlOf("find u pick coalesce(a, b, c) as x")).toBe(
			`SELECT COALESCE("a", "b", "c") AS "x" FROM "u"`
		);
	});

	it("call range : round(x, 2) — 2-args double-cast (fix quirk 42883)", () => {
		// round(double, int) n'existe pas en PG (quirk documenté). Le renderer
		// wrap ::numeric pour typer, puis re-cast ::double precision pour ne
		// pas casser le contrat de type côté driver pg (numeric → string JS).
		expect(sqlOf("find t pick round(rate, 2) as r")).toBe(
			`SELECT ROUND(("rate")::numeric, $1)::double precision AS "r" FROM "t"`
		);
	});

	it("call range : round(x) mono-arg inchangé", () => {
		expect(sqlOf("find t pick round(rate) as r")).toBe(
			`SELECT ROUND("rate") AS "r" FROM "t"`
		);
	});

	it("call range : round(cast(x as float), 3) — fix E2E RNAcentral", () => {
		// Le cas qui a explosé sprint 2 : cast(x as float) → double precision,
		// puis round(double, int) → 42883. B++ absorbe le quirk.
		expect(sqlOf("find t pick round(cast(rate as float), 3) as r")).toBe(
			`SELECT ROUND((CAST("rate" AS double precision))::numeric, $1)::double precision AS "r" FROM "t"`
		);
	});

	it("call dans WHERE compare", () => {
		expect(sqlOf(`find users where upper(name) = "ALICE"`)).toBe(
			`SELECT * FROM "users" WHERE UPPER("name") = $1`
		);
	});

	it("call composé avec arithmétique", () => {
		expect(sqlOf(`find t pick length(name) + 1 as padded_len`)).toContain(
			`(LENGTH("name") + $1)`
		);
	});
});

describe("call node — erreurs lower", () => {
	it("fonction inconnue → lower_unknown_function", () => {
		expect(() => compile("find t pick unknown_fn(x) as v", { engine: "postgres" })).toThrow(
			/'unknown_fn' inconnue/
		);
	});

	it("arité insuffisante → lower_call_arity", () => {
		expect(() => compile("find t pick upper() as v", { engine: "postgres" })).toThrow(
			/'upper' attend 1 argument, reçu 0/
		);
	});

	it("arité excessive → lower_call_arity", () => {
		expect(() => compile("find t pick upper(x, y) as v", { engine: "postgres" })).toThrow(
			/'upper' attend 1 argument, reçu 2/
		);
	});

	it("type mismatch statique (littéral number pour upper string)", () => {
		expect(() => compile("find t pick upper(42) as v", { engine: "postgres" })).toThrow(
			/'upper' arg 1 attend string, reçu number/
		);
	});

	it("call `propagate` autorisé en write (sprint 3 — writeNullBehavior activé)", () => {
		// upper est déclaré `writeNullBehavior: "propagate"` → passe en write.
		const stmt = parse(tokenize("update t where upper(name) = \"X\" set y = 1"));
		if (stmt.operation !== "update") throw new Error("attendu update");
		expect(() => lowerMutation(stmt)).not.toThrow();
	});

	it("call sans writeNullBehavior déclaré reste refusé en write (concat)", () => {
		// concat volontairement NON déclaré (divergence PG absorb vs Mongo propagate).
		const stmt = parse(tokenize('update t where concat(a, b) = "xy" set y = 1'));
		if (stmt.operation !== "update") throw new Error("attendu update");
		expect(() => lowerMutation(stmt)).toThrow(/sémantique NULL non déclarée/i);
	});
});
