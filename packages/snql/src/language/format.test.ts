/**
 * Formatter — vérifie l'idempotence, le block style multi-ligne des stages
 * pick/sort/set (≥ 3 items) et le block style multi-ligne des object/array
 * literals (≥ 3 items) avec nesting.
 */

import { describe, expect, it } from "vitest";
import { formatSnql } from "./format";

function fmt(source: string): string {
	return formatSnql(source);
}

describe("format — canonique linéaire", () => {
	it("requête simple : chaque stage sur sa ligne", () => {
		expect(fmt("get users where age > 30 limit 5")).toBe(
			"get users\n  where age > 30\n  limit 5"
		);
	});

	it("idempotent : format(format(x)) == format(x)", () => {
		const src = "find rna as r where r.id > 100 sort r.id desc pick r.id, r.upi, r.len limit 10";
		const once = fmt(src);
		const twice = fmt(once);
		expect(twice).toBe(once);
	});
});

describe("format — pick multi-ligne (≥ 3 items)", () => {
	it("pick avec 2 items reste inline", () => {
		expect(fmt("get t pick a, b")).toBe("get t\n  pick a, b");
	});

	it("pick avec 3 items passe en block style", () => {
		expect(fmt("get t pick a, b, c")).toBe(
			"get t\n  pick\n    a,\n    b,\n    c"
		);
	});
});

describe("format — object literal multi-ligne (≥ 3 clés)", () => {
	it("object avec 2 clés reste inline", () => {
		expect(fmt("get t pick {a: 1, b: 2} as d")).toBe(
			"get t\n  pick {a: 1, b: 2} as d"
		);
	});

	it("object avec 3 clés → block style, closer aligné avec le stage", () => {
		expect(fmt("get t pick {a: 1, b: 2, c: 3} as d")).toBe(
			"get t\n  pick {\n    a: 1,\n    b: 2,\n    c: 3\n  } as d"
		);
	});

	it("empty object reste inline", () => {
		expect(fmt("get t pick {} as empty")).toBe(
			"get t\n  pick {} as empty"
		);
	});

	it("add doc avec 3 clés → block style (into est un stage keyword)", () => {
		expect(
			fmt('add {name: "Alice", email: "a@x.com", age: 30} into users')
		).toBe(
			'add {\n    name: "Alice",\n    email: "a@x.com",\n    age: 30\n  }\n  into users'
		);
	});
});

describe("format — array literal multi-ligne (≥ 3 items)", () => {
	it("array avec 2 items reste inline", () => {
		expect(fmt("get t pick [10, 20] as arr")).toBe(
			"get t\n  pick [10, 20] as arr"
		);
	});

	it("array avec 3 items → block style, closer aligné stage", () => {
		expect(fmt("get t pick [10, 20, 30] as arr")).toBe(
			"get t\n  pick [\n    10,\n    20,\n    30\n  ] as arr"
		);
	});

	it("empty array reste inline", () => {
		expect(fmt("get t pick [] as empty")).toBe(
			"get t\n  pick [] as empty"
		);
	});
});

describe("format — nesting object/array multi-ligne", () => {
	it("object nested dans object multi-ligne : indent doublé pour l'enfant", () => {
		const out = fmt(
			"get t pick {a: 1, b: 2, c: {x: 1, y: 2, z: 3}} as d"
		);
		// Object externe : contenu à 4 spaces, closer à 2. Object interne :
		// contenu à 8 spaces, closer à 4.
		expect(out).toContain("\n    a: 1,");
		expect(out).toContain("\n    c: {");
		expect(out).toContain("\n        x: 1,");
		expect(out).toContain("\n        z: 3");
		expect(out).toContain("\n    }");
	});

	it("array multi-ligne dans object multi-ligne", () => {
		const out = fmt("get t pick {a: 1, b: 2, arr: [10, 20, 30]} as d");
		expect(out).toContain("\n    arr: [");
		expect(out).toContain("\n        10,");
		expect(out).toContain("\n        30");
		expect(out).toContain("\n    ]");
	});
});

describe("format — pick multi-ligne + object literal item", () => {
	it("pick 3 items dont un object literal multi-ligne : indent hérité", () => {
		expect(
			fmt("get t pick x, {a: 1, b: 2, c: 3} as y, z")
		).toBe(
			"get t\n  pick\n    x,\n    {\n        a: 1,\n        b: 2,\n        c: 3\n    } as y,\n    z"
		);
	});
});
