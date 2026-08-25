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
		const src = "find rna as r where r.id > 100 pick r.id, r.upi, r.len sort r.id desc limit 10";
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

// ═══════════════════════════════════════════════════════════════════════════
// transaction + savepoint + `;` séparateur
// ═══════════════════════════════════════════════════════════════════════════

describe("format — transaction bloc", () => {
	it("transaction simple : `{` ouvre bloc + `;` split + stmts indentés", () => {
		expect(
			fmt("transaction { find users pick id; find agency pick name }")
		).toBe(
			"transaction {\n  find users\n    pick id;\n  find agency\n    pick name\n}"
		);
	});

	it("isolation reste inline avec `transaction`", () => {
		expect(
			fmt(
				"transaction isolation serializable { find users pick id; find agency pick name }"
			)
		).toBe(
			"transaction isolation serializable {\n  find users\n    pick id;\n  find agency\n    pick name\n}"
		);
	});

	it("savepoint bloc — indent enfant + stages à indent supérieur", () => {
		expect(
			fmt(
				"transaction { find users pick id; savepoint sp1 { update users set is_active = true }; find agency pick name }"
			)
		).toBe(
			[
				"transaction {",
				"  find users",
				"    pick id;",
				"  savepoint sp1 {",
				"    update users",
				"      set is_active = true",
				"  };",
				"  find agency",
				"    pick name",
				"}"
			].join("\n")
		);
	});

	it("idempotent : format(format(x)) == format(x) sur transaction", () => {
		const src =
			"transaction isolation serializable { find resource limit 1; savepoint sp1 { find agency limit 1 }; find resource_pair limit 1 }";
		const once = fmt(src);
		const twice = fmt(once);
		expect(twice).toBe(once);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Post-format-audit — stages intra-parens et on-conflict-action inline
// ═══════════════════════════════════════════════════════════════════════════

describe("format — stages intra-parens restent inline", () => {
	it("sort intra `string_agg(…)` reste inline", () => {
		expect(
			fmt('get t pick string_agg(name, ", " sort name asc) as names')
		).toBe(
			'get t\n  pick string_agg(name, ", " sort name asc) as names'
		);
	});

	it("sort intra `over (…)` de window function reste inline", () => {
		expect(
			fmt(
				"get t pick id, row_number() over (partition dept sort salary desc) as rank"
			)
		).toBe(
			"get t\n  pick id, row_number() over (partition dept sort salary desc) as rank"
		);
	});

	it("pick intra sub-query `in (find …)` reste inline", () => {
		expect(fmt("find users where id in (find orders pick user_id)")).toBe(
			"find users\n  where id in (find orders pick user_id)"
		);
	});

	it("where intra sub-query `exists (find …)` reste inline", () => {
		expect(
			fmt("find users as u where exists (find orders where user_id = u.id)")
		).toBe(
			"find users as u\n  where exists (find orders where user_id = u.id)"
		);
	});

	it("insert-select : where + pick intra `(find …)` restent inline", () => {
		expect(
			fmt(
				"add (find users where active pick id, email as mail) into archive"
			)
		).toBe(
			"add (find users where active pick id, email as mail)\n  into archive"
		);
	});
});

describe("format — on-conflict edit action reste inline", () => {
	it("`edit set …` inline sans split", () => {
		expect(
			fmt("add {a: 1, b: 2, c: 3} into t on conflict (a) edit set b = new.b")
		).toBe(
			"add {\n    a: 1,\n    b: 2,\n    c: 3\n  }\n  into t on conflict (a) edit set b = new.b"
		);
	});

	it("`edit set … where …` inline entièrement", () => {
		expect(
			fmt(
				"add {a: 1, b: 2, c: 3} into t on conflict (a) edit set b = new.b where a < new.a"
			)
		).toBe(
			"add {\n    a: 1,\n    b: 2,\n    c: 3\n  }\n  into t on conflict (a) edit set b = new.b where a < new.a"
		);
	});

	it("`pick count` post-action reste split (fin de stmt)", () => {
		expect(
			fmt(
				"add {a: 1, b: 2, c: 3} into t on conflict (a) edit set b = new.b pick count"
			)
		).toBe(
			"add {\n    a: 1,\n    b: 2,\n    c: 3\n  }\n  into t on conflict (a) edit set b = new.b\n  pick count"
		);
	});

	it("`ignore` (pas `edit`) : pas d'inline forcé", () => {
		expect(
			fmt("add {a: 1, b: 2, c: 3} into t on conflict (a) ignore pick count")
		).toBe(
			"add {\n    a: 1,\n    b: 2,\n    c: 3\n  }\n  into t on conflict (a) ignore\n  pick count"
		);
	});
});

describe("format — propagation multi-ligne parent ← enfant", () => {
	it("array 2 rows dont chaque objet est lourd → array parent ouvert", () => {
		expect(
			fmt("add [{a: 1, b: 2, c: 3}, {a: 4, b: 5, c: 6}] into t")
		).toBe(
			[
				"add [",
				"    {",
				"        a: 1,",
				"        b: 2,",
				"        c: 3",
				"    },",
				"    {",
				"        a: 4,",
				"        b: 5,",
				"        c: 6",
				"    }",
				"  ]",
				"  into t"
			].join("\n")
		);
	});

	it("array 1 row lourd → array parent ouvert (pas d'objet décollé à droite)", () => {
		expect(
			fmt("add [{a: 1, b: 2, c: 3, d: 4, e: 5}] into t")
		).toBe(
			[
				"add [",
				"    {",
				"        a: 1,",
				"        b: 2,",
				"        c: 3,",
				"        d: 4,",
				"        e: 5",
				"    }",
				"  ]",
				"  into t"
			].join("\n")
		);
	});

	it("array 2 rows objets légers → tout reste inline", () => {
		expect(
			fmt("add [{a: 1, b: 2}, {c: 3, d: 4}] into t")
		).toBe(
			"add [{a: 1, b: 2}, {c: 3, d: 4}]\n  into t"
		);
	});

	it("idempotence sur le canonique employé lourd", () => {
		const src =
			'add { first_name: "Nancy", last_name: "Edwards", email: "nancy@chinook.com", phone: "+1 (555) 555-5555", city: "Calgary", country: "Canada", postal_code: "T3B 3L4", birth_date: "1961-06-15", hire_date: "2011-05-01", title: "Sales Manager", reports_to: 1 } into employee';
		const once = fmt(src);
		const twice = fmt(once);
		expect(twice).toBe(once);
	});

	it("tolérant à source incomplète (accolades non appariées) — pas de crash", () => {
		expect(() => fmt("add {a: 1, b: 2, c: into t")).not.toThrow();
		expect(() => fmt('add { name: "x", email: "y')).not.toThrow();
	});
});

describe("format — let CTE", () => {
	it("un let + body — `;` en fin de ligne, body sur nouvelle ligne", () => {
		expect(fmt('let x = find users; find x pick email')).toBe(
			'let x = find users;\nfind x\n  pick email'
		);
	});

	it("plusieurs let — chaque `;` split", () => {
		expect(fmt('let a = find users; let b = find a; find b pick id')).toBe(
			'let a = find users;\nlet b = find a;\nfind b\n  pick id'
		);
	});

	it("body avec stages multi-ligne — chaque stage indenté", () => {
		expect(
			fmt(
				'let jazz = find genre where name = "Jazz"; find track where genre_id in (find jazz pick genre_id) pick name, milliseconds sort milliseconds desc limit 10'
			)
		).toBe(
			'let jazz = find genre\n  where name = "Jazz";\nfind track\n  where genre_id in (find jazz pick genre_id)\n  pick name, milliseconds\n  sort milliseconds desc\n  limit 10'
		);
	});
});

describe("format — DDL create table body", () => {
	it("body 1 field → multi-ligne quand même (structurel, pas comme un object literal)", () => {
		expect(fmt("create table t {id: uuid}")).toBe(
			"create table t {\n  id: uuid\n}"
		);
	});

	it("body 2 fields → multi-ligne (règle body ≠ règle object literal)", () => {
		expect(fmt("create table t {id: uuid, email: text}")).toBe(
			"create table t {\n  id: uuid,\n  email: text\n}"
		);
	});

	it("body avec primary key compound — commas dans parens PK restent inline", () => {
		expect(
			fmt(
				"create table users {id: uuid not null, email: text unique, primary key (id, email)}"
			)
		).toBe(
			[
				"create table users {",
				"  id: uuid not null,",
				"  email: text unique,",
				"  primary key (id, email)",
				"}"
			].join("\n")
		);
	});

	it("body avec default json compound 2 items → nested reste inline", () => {
		expect(
			fmt(
				'create table t {id: uuid, meta: json default {tier: "free", quota: 10}}'
			)
		).toBe(
			[
				"create table t {",
				"  id: uuid,",
				'  meta: json default {tier: "free", quota: 10}',
				"}"
			].join("\n")
		);
	});

	it("body avec default json compound 3 items → nested multi-ligne à baseIndent + ITEM_INDENT", () => {
		expect(
			fmt(
				'create table t {id: uuid, config: json default {tier: "free", quota: 10, ttl_days: 30}}'
			)
		).toBe(
			[
				"create table t {",
				"  id: uuid,",
				"  config: json default {",
				'      tier: "free",',
				"      quota: 10,",
				"      ttl_days: 30",
				"  }",
				"}"
			].join("\n")
		);
	});

	it("idempotent : format(format(x)) == format(x) sur body avec default json compound", () => {
		const src =
			'create table t_json_e2e {id: uuid, meta: json default {tier: "free", quota: 10}}';
		const once = fmt(src);
		const twice = fmt(once);
		expect(twice).toBe(once);
	});

	it("`add unique index (a, b) into t` — espace conservé entre `index` et `(`", () => {
		expect(fmt("add unique index (email, tenant_id) into users")).toBe(
			"add unique index (email, tenant_id)\n  into users"
		);
	});

	it("`primary key (a, b)` — espace conservé entre `key` et `(`", () => {
		expect(
			fmt("create table t {id: uuid, name: text, primary key (id, name)}")
		).toBe(
			[
				"create table t {",
				"  id: uuid,",
				"  name: text,",
				"  primary key (id, name)",
				"}"
			].join("\n")
		);
	});
});
