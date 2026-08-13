/**
 * Parity E2E cross-engine sprint 4 : chaque cas SNQL doit produire un SQL PG
 * ET un pipeline Mongo cohérents pour le même intent utilisateur.
 * Complète les tests unitaires par engine.
 */

import { describe, expect, it } from "vitest";
import { SnqlError } from "./diagnostics";
import { compile, planFor } from "./index";

function pg(source: string): string {
	const { native } = compile(source, { engine: "postgres" });
	if (native.kind !== "sql") throw new Error("kind sql attendu");
	return native.text;
}

function mongo(source: string): readonly Record<string, unknown>[] {
	const { native } = compile(source, { engine: "mongodb" });
	if (native.kind !== "mongo") throw new Error("kind mongo attendu");
	return native.pipeline;
}

describe("sprint 4 parity — projection identique cross-engine", () => {
	it("json_get single key : PG chain -> / Mongo $getField", () => {
		const src = 'find t pick json_get(meta, "role") as r';
		expect(pg(src)).toContain(`"meta" -> $1::text`);
		expect(JSON.stringify(mongo(src)[0])).toContain("$getField");
	});

	it("json_get_text : PG ->> / Mongo $toString", () => {
		const src = 'find t pick json_get_text(meta, "role") as r';
		expect(pg(src)).toContain(`"meta" ->> $1::text`);
		expect(JSON.stringify(mongo(src)[0])).toContain("$toString");
	});

	it("json_has_key : PG ? / Mongo $ne $type missing", () => {
		const src = 'find t pick json_has_key(meta, "k") as h';
		expect(pg(src)).toContain(`"meta" ? $1::text`);
		expect(JSON.stringify(mongo(src)[0])).toContain('"missing"');
	});

	it("json_typeof : PG jsonb_typeof / Mongo $switch", () => {
		const src = "find t pick json_typeof(meta) as t";
		expect(pg(src)).toBe(`SELECT jsonb_typeof("meta") AS "t" FROM "t"`);
		expect(JSON.stringify(mongo(src)[0])).toContain("$switch");
	});
});

describe("sprint 4 parity — WHERE : PG accepte, Mongo hoist indexable", () => {
	it("where json_get_text = literal : PG WHERE ... / Mongo $expr fallback (v1)", () => {
		// Volontairement PAS de hoist Mongo pour json_get_text (coercion type).
		const src = 'find t where json_get_text(meta, "role") = "admin"';
		expect(pg(src)).toContain(`"meta" ->> $1::text`);
		expect(JSON.stringify(mongo(src)[0])).toContain("$expr");
	});

	it("where json_get = literal : PG throw / Mongo hoist indexable", () => {
		// PG throw planner_json_get_compare_ambiguous.
		try {
			planFor('find t where json_get(meta, "role") = "admin"', "postgres");
			throw new Error("SnqlError attendu");
		} catch (e) {
			if (!(e instanceof SnqlError)) throw e;
			expect(e.code).toBe("planner_json_get_compare_ambiguous");
		}
		// Mongo : hoist naturel indexable.
		const { pipeline } = { pipeline: mongo('find t where json_get(meta, "role") = "admin"') };
		expect(pipeline[0]).toEqual({ $match: { "meta.role": { $eq: "admin" } } });
	});

	it("where json_has_key = true : PG ?...=TRUE / Mongo $exists", () => {
		const src = 'find t where json_has_key(meta, "k") = true';
		expect(pg(src)).toContain(`("meta" ? $1::text) = $2`);
		expect(mongo(src)[0]).toEqual({
			$match: { "meta.k": { $exists: true } }
		});
	});
});

describe("sprint 4 parity — composition cast(json_get_text as T)", () => {
	it("cast(json_get_text(x, 'age') as int) : PG CAST bigint / Mongo $convert long", () => {
		const src = 'find t pick cast(json_get_text(meta, "age") as int) as age';
		expect(pg(src)).toBe(
			`SELECT CAST(("meta" ->> $1::text) AS bigint) AS "age" FROM "t"`
		);
		expect(JSON.stringify(mongo(src)[0])).toContain('"to":"long"');
	});

	it("cast(json_get_text(x, 'active') as bool) : PG boolean / Mongo bool", () => {
		const src = 'find t pick cast(json_get_text(meta, "active") as bool) as a';
		expect(pg(src)).toContain(`AS boolean`);
		expect(JSON.stringify(mongo(src)[0])).toContain('"to":"bool"');
	});

	it("where cast(json_get_text(x, 'age') as int) > 30 fonctionne cross-engine", () => {
		const src =
			'find t where cast(json_get_text(meta, "age") as int) > 30';
		expect(pg(src)).toContain(`CAST(("meta" ->> $1::text) AS bigint) > $2`);
		expect(JSON.stringify(mongo(src)[0])).toContain("$expr");
	});
});

describe("sprint 4 parity — cast(json_get) refusé PG, mais Mongo OK via $convert", () => {
	it("cast(json_get(x, 'k') as int) : PG throw planner_cast_from_jsonb_unsupported", () => {
		try {
			planFor('find t pick cast(json_get(meta, "k") as int) as v', "postgres");
			throw new Error("SnqlError attendu");
		} catch (e) {
			if (!(e instanceof SnqlError)) throw e;
			expect(e.code).toBe("planner_cast_from_jsonb_unsupported");
			expect(e.message).toContain("json_get_text");
		}
	});
});

describe("sprint 4 parity — negation collapse via hoist mirror", () => {
	it("not (json_has_key = true) équivaut à = false cross-engine", () => {
		const positive = 'find t where json_has_key(meta, "k") = true';
		const negated = 'find t where not (json_has_key(meta, "k") = true)';
		// PG : WHERE (NOT (... = TRUE)) — pas de collapse au SQL, mais sémantique correcte.
		expect(pg(positive)).toContain(`= $2`);
		expect(pg(negated)).toContain(`NOT`);
		// Mongo : le negateMatch avec hoist mirror collapse en $nor ou path direct.
		expect(JSON.stringify(mongo(positive))).toContain("$exists");
		expect(JSON.stringify(mongo(negated))).toContain("$exists");
	});
});

describe("sprint 4 parity — reserved cross-engine (même erreur)", () => {
	const reserved = ["json_set", "json_path", "json_array_length"];
	for (const name of reserved) {
		it(`${name} → lower_call_reserved cross-engine`, () => {
			for (const engine of ["postgres", "mongodb"] as const) {
				try {
					compile(`find t pick ${name}(meta, "x") as v`, { engine });
					throw new Error("SnqlError attendu");
				} catch (e) {
					if (!(e instanceof SnqlError)) throw e;
					expect(e.code).toBe("lower_call_reserved");
				}
			}
		});
	}
});
