/**
 * Object/Array literals E2E — parser + lower + codegen PG + codegen Mongo +
 * insert widening + json_contains PG débloqué + planner guards.
 * Un seul fichier consolidé pour couvrir l'ensemble des cas.
 */

import { describe, expect, it } from "vitest";
import { SnqlError } from "./diagnostics";
import {
	compile,
	getMapper,
	lowerMutation,
	parse,
	planFor,
	tokenize
} from "./index";

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

function pgMutation(source: string): { text: string; params: readonly unknown[] } {
	const stmt = parse(tokenize(source));
	if (stmt.operation === "select") throw new Error("mutation attendue");
	const nat = getMapper("postgres").mapMutation(lowerMutation(stmt));
	if (nat.kind !== "sql") throw new Error("kind sql attendu");
	return { text: nat.text, params: nat.params };
}

function mongoMutation(source: string) {
	const stmt = parse(tokenize(source));
	if (stmt.operation === "select") throw new Error("mutation attendue");
	return getMapper("mongodb").mapMutation(lowerMutation(stmt));
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
// STEP 12 — Parser (dup keys, depth, keys types, empty, keywords)
// ═══════════════════════════════════════════════════════════════════════════

describe("parser object literal", () => {
	it("bare key : {n: 1}", () => {
		expect(() => pg('find t pick {n: 1} as d')).not.toThrow();
	});

	it("quoted key : {\"n\": 1}", () => {
		expect(() => pg('find t pick {"n": 1} as d')).not.toThrow();
	});

	it("keyword en bare key : {from: 1, group: 2}", () => {
		expect(() =>
			pg('find t pick {from: 1, group: 2} as route')
		).not.toThrow();
	});

	it("empty object : {}", () => {
		expect(() => pg('find t pick {} as empty')).not.toThrow();
	});

	it("dup key refusé : {a: 1, a: 2}", () => {
		expectCode(
			() => pg('find t pick {a: 1, a: 2} as d'),
			"parse_object_literal_duplicate_key"
		);
	});

	it("colon manquant : {a 1}", () => {
		expectCode(
			() => pg('find t pick {a 1} as d'),
			"parse_object_literal_colon_expected"
		);
	});

	it("close manquant : {a: 1", () => {
		expectCode(
			() => pg('find t pick {a: 1'),
			"parse_object_literal_close_expected"
		);
	});

	it("dup key hérité par insert (fix transversal) : add {a:1, a:2} into t", () => {
		expectCode(
			() => pg('add {a: 1, a: 2} into t'),
			"parse_object_literal_duplicate_key"
		);
	});
});

describe("parser array literal", () => {
	it("[10, 20, 30]", () => {
		expect(() => pg('find t pick [10, 20, 30] as arr')).not.toThrow();
	});

	it("empty array : []", () => {
		expect(() => pg('find t pick [] as empty')).not.toThrow();
	});

	it("mixed items : [r.id, 42, \"str\"]", () => {
		expect(() => pg('find users as r pick [r.id, 42, "str"] as t')).not.toThrow();
	});

	it("close manquant : [1, 2", () => {
		expectCode(
			() => pg('find t pick [1, 2'),
			"parse_array_literal_close_expected"
		);
	});

	it("in [...] inchangé (Expr.in dédié pour fast-path Mongo)", () => {
		// Non-régression : where x in [a, b] ne casse pas.
		expect(() => pg('find t where role in ["admin", "user"]')).not.toThrow();
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// STEP 13 — Codegen PG (jsonb_build_object + insert path)
// ═══════════════════════════════════════════════════════════════════════════

describe("codegen PG object literal", () => {
	it("{n: 1} → jsonb_build_object($1::text, $2::bigint) — keys castées text (désambigüe 42P18)", () => {
		const { text, params } = pg('find t pick {n: 1} as d');
		expect(text).toBe(
			`SELECT jsonb_build_object($1::text, $2::bigint) AS "d" FROM "t"`
		);
		expect(params).toEqual(["n", 1]);
	});

	it("keys ET values bindées (anti-injection sur quoted keys type O'Brien)", () => {
		const { params } = pg(`find t pick {"O'Brien": 42} as d`);
		expect(params).toEqual(["O'Brien", 42]);
	});

	it("empty : {} → jsonb_build_object()", () => {
		expect(pg('find t pick {} as d').text).toContain("jsonb_build_object()");
	});

	it("value type cast per-scalar : boolean/text/decimal", () => {
		const { text } = pg(
			'find t pick {b: true, s: "hi", n: 1.5} as d'
		);
		expect(text).toContain("::boolean");
		expect(text).toContain("::text");
		expect(text).toContain("::numeric");
	});

	it("value avec field ref : {name: r.name}", () => {
		expect(pg('find users as r pick {name: r.name} as u').text).toBe(
			`SELECT jsonb_build_object($1::text, "r"."name") AS "u" FROM "users" AS "r"`
		);
	});

	it("nested : {arr: [10, 20], m: {k: \"v\"}}", () => {
		const { text } = pg('find t pick {arr: [10, 20], m: {k: "v"}} as d');
		expect(text).toContain("jsonb_build_array");
		// Le jsonb_build_object externe wrappe le array + object nested.
		expect(text.match(/jsonb_build_object/g)?.length).toBe(2);
	});
});

describe("codegen PG array literal", () => {
	it("[10, 20, 30] → jsonb_build_array($1::bigint, $2::bigint, $3::bigint)", () => {
		const { text } = pg('find t pick [10, 20, 30] as a');
		expect(text).toBe(
			`SELECT jsonb_build_array($1::bigint, $2::bigint, $3::bigint) AS "a" FROM "t"`
		);
	});

	it("empty : [] → jsonb_build_array()", () => {
		expect(pg('find t pick [] as e').text).toContain("jsonb_build_array()");
	});
});

describe("codegen PG insert path — jsonLiteral widening", () => {
	it("add {meta: {tier: \"gold\"}} into t — plus besoin de raw JSON !", () => {
		const { text } = pgMutation('add {meta: {tier: "gold"}} into t');
		// L'insert émet VALUES (jsonb_build_object(...)) au lieu d'un $N bindé
		// scalar — c'est le débloc du workaround `cast("{...}" as json)`.
		expect(text).toContain("jsonb_build_object");
		expect(text).toContain(`INSERT INTO "t"`);
	});

	it("add {tags: [\"a\", \"b\"]} into products — array literal widening", () => {
		const { text } = pgMutation('add {tags: ["a", "b"]} into products');
		expect(text).toContain("jsonb_build_array");
	});

	it("insert scalar simple reste bindé $N (non-régression)", () => {
		const { text, params } = pgMutation('add {name: "Alice", age: 30} into u');
		expect(text).toBe(
			`INSERT INTO "u" ("name", "age") VALUES ($1, $2) RETURNING *`
		);
		expect(params).toEqual(["Alice", 30]);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// STEP 14 — Codegen Mongo + guards Mongo-only
// ═══════════════════════════════════════════════════════════════════════════

describe("codegen Mongo object/array literal — BSON natif", () => {
	it("{n: 1, s: \"hi\"} → BSON natif dans $project", () => {
		const pipeline = mongo('find t pick {n: 1, s: "hi"} as d');
		expect(pipeline[0]).toEqual({
			$project: { d: { n: 1, s: "hi" }, _id: 0 }
		});
	});

	it("[10, 20, 30] → BSON array natif", () => {
		const pipeline = mongo('find t pick [10, 20, 30] as a');
		expect(pipeline[0]).toEqual({
			$project: { a: [10, 20, 30], _id: 0 }
		});
	});

	it("field ref préservé dans object : {name: r.name} → {name: '$name'}", () => {
		const pipeline = mongo('find users as r pick {name: r.name} as u');
		expect(pipeline[0]).toEqual({
			$project: { u: { name: "$name" }, _id: 0 }
		});
	});
});

describe("codegen Mongo — object literal in where (#12)", () => {
	it("where col = {n:1} → accepté sur Mongo (comparaison BSON native)", () => {
		// item #12 — retire l'ancien refus `plan_mongo_compare_object
		// _literal_unsupported`. Mongo compare nativement les objects BSON (ordre
		// des clés préservé). Divergence order-sensitivity documentée squiggly INFO.
		expect(() =>
			planFor('find t where meta = {n: 1}', "mongodb")
		).not.toThrow();
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// STEP 15 — E2E parity + composition + write + json_contains PG débloqué
// ═══════════════════════════════════════════════════════════════════════════

describe("composition — object literal + json fns", () => {
	it("json_get_text({n:\"hi\"}, \"n\") = \"hi\" — SANS raw JSON déguisé", () => {
		// Cas motivant : plus besoin d'écrire
		// cast("{\\"n\\":\\"hi\\"}" as json) pour extraire une valeur.
		const { text } = pg('find t pick json_get_text({n: "hi"}, "n") as v');
		expect(text).toContain("jsonb_build_object");
		expect(text).toContain("->>");
	});

	it("json_typeof({}) = 'object' cross-engine", () => {
		expect(pg('find t pick json_typeof({}) as t').text).toContain(
			"jsonb_typeof"
		);
		expect(JSON.stringify(mongo('find t pick json_typeof({}) as t')[0])).toContain(
			"$switch"
		);
	});
});

describe("json_contains PG débloqué ()", () => {
	it("json_contains(meta, {archived: true}) → PG @> avec cast jsonb", () => {
		const { text } = pg(
			'find t pick json_contains(meta, {archived: true}) as has'
		);
		expect(text).toContain("@>");
		expect(text).toContain("jsonb_build_object");
	});

	it("where json_contains(meta, {archived: true}) — pattern courant", () => {
		expect(() =>
			pg('find users where json_contains(meta, {archived: true}) = true')
		).not.toThrow();
	});

	it("json_contains Mongo object literal → $and $eq $getField", () => {
		const nat = mongo(
			'find t pick json_contains(meta, {archived: true}) as h'
		);
		const serialized = JSON.stringify(nat);
		expect(serialized).toContain("$getField");
		expect(serialized).toContain("archived");
	});

	it("json_contains Mongo array literal → $setIsSubset", () => {
		const nat = mongo('find t pick json_contains(tags, [1, 2, 3]) as h');
		expect(JSON.stringify(nat)).toContain("$setIsSubset");
	});

	it("json_contains Mongo nested object → refus planner_mongo_json_contains_nested_unsupported", () => {
		expectCode(
			() => mongo('find t pick json_contains(meta, {inner: {deep: 1}}) as h'),
			"planner_mongo_json_contains_nested_unsupported"
		);
	});

	it("json_contains Mongo array element nested → refus", () => {
		expectCode(
			() => mongo('find t pick json_contains(tags, [{k: 1}]) as h'),
			"planner_mongo_json_contains_nested_unsupported"
		);
	});
});

describe("planner guards cast literal", () => {
	it("cast({n:1} as json) → plan_cast_literal_redundant", () => {
		expectCode(
			() => planFor('find t pick cast({n: 1} as json) as d', "postgres"),
			"plan_cast_literal_redundant"
		);
	});

	it("cast({n:1} as text) → plan_cast_literal_to_text (json_stringify)", () => {
		expectCode(
			() => planFor('find t pick cast({n: 1} as text) as s', "postgres"),
			"plan_cast_literal_to_text"
		);
	});

	it("cast([1,2,3] as int) → plan_cast_literal_to_scalar", () => {
		expectCode(
			() => planFor('find t pick cast([1,2,3] as int) as n', "postgres"),
			"plan_cast_literal_to_scalar"
		);
	});
});

describe("write context — object literal + call safe", () => {
	it("update set doc = {archived: true} passe (all-scalar literal)", () => {
		expect(() =>
			pgMutation('update t where id = 1 set doc = {archived: true}')
		).not.toThrow();
	});

	it("insert Mongo avec object literal — BSON natif via bsonStoreValue dispatch", () => {
		const nat = mongoMutation('add {meta: {tier: "gold"}} into u');
		if (nat.kind !== "mongo-write") throw new Error("mongo-write attendu");
		const serialized = JSON.stringify(nat);
		expect(serialized).toContain('"tier":"gold"');
	});
});

describe("non-régression — insert scalar reste inchangé", () => {
	it("add {name: \"Alice\", age: 30} into users (comportement historique)", () => {
		expect(pgMutation('add {name: "Alice", age: 30} into users').text).toBe(
			`INSERT INTO "users" ("name", "age") VALUES ($1, $2) RETURNING *`
		);
	});
});
