import { describe, expect, it } from "vitest";
import { compile, lowerMutation, parse, tokenize } from "../index";
import { checkArity, describeArity } from "./arity";
import { SNQL_FUNCTIONS, createRegistry, type FunctionEntry } from "./index";

describe("call node — registry + arity", () => {
	it("SNQL_FUNCTIONS contient les 8 builtins sprint 1", () => {
		expect(SNQL_FUNCTIONS.names()).toEqual(
			new Set([
				"upper",
				"lower",
				"length",
				"abs",
				"round",
				"coalesce",
				"now",
				"concat"
			])
		);
	});

	it("forEngine expose les fonctions supportées par engine", () => {
		expect(SNQL_FUNCTIONS.forEngine("postgres").size).toBe(8);
		expect(SNQL_FUNCTIONS.forEngine("mongodb").size).toBe(8);
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

	it("call range : round(x, 2)", () => {
		expect(sqlOf("find t pick round(rate, 2) as r")).toContain("ROUND(");
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

	it("call en position write refusé (update predicate)", () => {
		expect(() =>
			compile("update t where upper(name) = \"X\" set y = 1", {
				engine: "postgres"
			})
		).toThrow(/lecture seule/i);
		// via lowerMutation direct :
		const stmt = parse(tokenize("update t where upper(name) = \"X\" set y = 1"));
		if (stmt.operation !== "update") throw new Error("attendu update");
		expect(() => lowerMutation(stmt)).toThrow(/contexte d'écriture/i);
	});
});
