/**
 * Sprint T2/11.5 typecheck cross-type predicates E2E — compare / in / arith / like.
 * Vérifie que le lower rejette les patterns type-incompatibles avec messages
 * actionables quand le SchemaModel est chargé. Permissif quand schema absent
 * (aucun faux positif — les tests existants continuent de passer).
 */

import { describe, expect, it } from "vitest";
import { SnqlError } from "./diagnostics";
import type { SchemaModel } from "./schema/model";
import { compile } from "./index";

// ─── Schéma synthétique ───────────────────────────────────────────────────
const SCHEMA: SchemaModel = {
	engine: "postgres",
	collections: [
		{
			name: "users",
			source: "declared",
			fields: [
				{ name: "id", type: "bigint", nullable: false, source: "declared" },
				{ name: "email", type: "string", nullable: false, source: "declared" },
				{ name: "name", type: "string", nullable: true, source: "declared" },
				{ name: "age", type: "int", nullable: true, source: "declared" },
				{ name: "active", type: "bool", nullable: false, source: "declared" },
				{ name: "created_at", type: "date", nullable: false, source: "declared" },
				{ name: "meta", type: "json", nullable: true, source: "declared" }
			]
		},
		{
			name: "orders",
			source: "declared",
			fields: [
				{ name: "id", type: "bigint", nullable: false, source: "declared" },
				{ name: "user_id", type: "bigint", nullable: false, source: "declared" },
				{ name: "user_email", type: "string", nullable: false, source: "declared" },
				{ name: "total", type: "float", nullable: false, source: "declared" }
			]
		}
	],
	relations: []
};

function pgSql(source: string): { text: string; params: readonly unknown[] } {
	const { native } = compile(source, { engine: "postgres", schema: SCHEMA });
	if (native.kind !== "sql") throw new Error("kind sql attendu");
	return { text: native.text, params: native.params };
}

function pgSqlNoSchema(source: string): { text: string; params: readonly unknown[] } {
	const { native } = compile(source, { engine: "postgres" });
	if (native.kind !== "sql") throw new Error("kind sql attendu");
	return { text: native.text, params: native.params };
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
// Compare type mismatch
// ═══════════════════════════════════════════════════════════════════════════

describe("compare typecheck", () => {
	it("string = number refusé", () => {
		expectCode(
			() => pgSql(`find users where email = 42`),
			"lower_type_mismatch_compare"
		);
	});

	it("bool = string refusé", () => {
		expectCode(
			() => pgSql(`find users where active = "true"`),
			"lower_type_mismatch_compare"
		);
	});

	it("int/bigint/float compatibles (widening)", () => {
		expect(() => pgSql(`find users where age = 30`)).not.toThrow();
		expect(() => pgSql(`find users where id = 123`)).not.toThrow();
	});

	it("string/uuid compatibles", () => {
		expect(() => pgSql(`find users where email = "a@b.c"`)).not.toThrow();
	});

	it("null compatible avec tout", () => {
		expect(() => pgSql(`find users where email = null`)).not.toThrow();
		expect(() => pgSql(`find users where age = null`)).not.toThrow();
	});

	it("json opaque (compatible avec tout)", () => {
		expect(() => pgSql(`find users where meta = 42`)).not.toThrow();
	});

	it("cross-type resté avec cast explicite", () => {
		expect(() =>
			pgSql(`find users where cast(id as text) = "42"`)
		).not.toThrow();
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// in [values] type mismatch
// ═══════════════════════════════════════════════════════════════════════════

describe("in [values] typecheck", () => {
	it("string field in [numbers] refusé", () => {
		expectCode(
			() => pgSql(`find users where email in [1, 2, 3]`),
			"lower_type_mismatch_in"
		);
	});

	it("string field in [strings] accepté", () => {
		expect(() =>
			pgSql(`find users where email in ["a", "b", "c"]`)
		).not.toThrow();
	});

	it("bigint field in [numbers] accepté", () => {
		expect(() => pgSql(`find users where id in [1, 2, 3]`)).not.toThrow();
	});

	it("in [] avec value mixte refusée sur 1re incompatible", () => {
		expectCode(
			() => pgSql(`find users where age in [1, "two", 3]`),
			"lower_type_mismatch_in"
		);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// in (subquery) type mismatch — le cas motivant sprint
// ═══════════════════════════════════════════════════════════════════════════

describe("in (subquery) typecheck", () => {
	it("string target in (subquery pick bigint) refusé — LE cas motivant", () => {
		// Reproduction du bug E2E : public_locus_name text vs locus_id bigint.
		expectCode(
			() => pgSql(`find users where email in (find orders pick user_id)`),
			"lower_type_mismatch_in_subquery"
		);
	});

	it("bigint target in (subquery pick bigint) accepté", () => {
		expect(() =>
			pgSql(`find users where id in (find orders pick user_id)`)
		).not.toThrow();
	});

	it("string target in (subquery pick string) accepté", () => {
		expect(() =>
			pgSql(`find users where email in (find orders pick user_email)`)
		).not.toThrow();
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// arith type mismatch
// ═══════════════════════════════════════════════════════════════════════════

describe("arith typecheck", () => {
	it("string + number refusé", () => {
		expectCode(
			() => pgSql(`find users pick email + 1 as x`),
			"lower_type_mismatch_arith"
		);
	});

	it("number + number accepté", () => {
		expect(() => pgSql(`find users pick age + 10 as x`)).not.toThrow();
	});

	it("bool * number refusé", () => {
		expectCode(
			() => pgSql(`find users pick active * 2 as x`),
			"lower_type_mismatch_arith"
		);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// like typecheck
// ═══════════════════════════════════════════════════════════════════════════

describe("like typecheck", () => {
	it("string like string accepté", () => {
		expect(() => pgSql(`find users where email like "%@b.c"`)).not.toThrow();
	});

	it("int like string refusé", () => {
		expectCode(
			() => pgSql(`find users where age like "3%"`),
			"lower_type_mismatch_like"
		);
	});

	it("string like number refusé (pattern doit être string)", () => {
		expectCode(
			() => pgSql(`find users where email like 42`),
			"lower_type_mismatch_like"
		);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Permissif sans schema (no false positive)
// ═══════════════════════════════════════════════════════════════════════════

describe("permissif sans schema", () => {
	it("tout type mismatch passe sans schema (rétrocompat)", () => {
		expect(() =>
			pgSqlNoSchema(`find u where email = 42`)
		).not.toThrow();
		expect(() =>
			pgSqlNoSchema(`find u where email in [1, 2, 3]`)
		).not.toThrow();
		expect(() =>
			pgSqlNoSchema(`find u where email in (find t pick uid)`)
		).not.toThrow();
	});
});
