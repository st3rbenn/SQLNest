/**
 * correlated exists + ScopeStack E2E — la subquery peut lire
 * les alias de la query outer via un scope stack module-level. Complète le
 * uncorrelated sans casser la rétrocompat.
 */

import { describe, expect, it } from "vitest";
import { SnqlError } from "./diagnostics";
import type { SchemaModel } from "./schema/model";
import { compile } from "./index";

const SCHEMA: SchemaModel = {
	engine: "postgres",
	collections: [
		{
			name: "users",
			source: "declared",
			fields: [
				{ name: "id", type: "bigint", nullable: false, source: "declared" },
				{ name: "email", type: "string", nullable: false, source: "declared" },
				{ name: "age", type: "int", nullable: true, source: "declared" }
			]
		},
		{
			name: "orders",
			source: "declared",
			fields: [
				{ name: "id", type: "bigint", nullable: false, source: "declared" },
				{ name: "user_id", type: "bigint", nullable: false, source: "declared" },
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
// Parser / Lower : correlated accepté
// ═══════════════════════════════════════════════════════════════════════════

describe("correlated exists", () => {
	it("exists avec ref outer alias accepté", () => {
		expect(() =>
			pgSql(
				`find users as u where exists (find orders as o where o.user_id = u.id)`
			)
		).not.toThrow();
	});

	it("uncorrelated exists reste OK (rétrocompat)", () => {
		expect(() =>
			pgSql(`find users as u where exists (find orders)`)
		).not.toThrow();
	});

	it("ref outer alias inconnu refusé", () => {
		expectCode(
			() =>
				pgSql(
					`find users as u where exists (find orders as o where o.user_id = zzz.id)`
				),
			"lower_unknown_alias"
		);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Correlated in (subquery)
// ═══════════════════════════════════════════════════════════════════════════

describe("correlated in (subquery)", () => {
	it("in (subquery corrélée) accepté", () => {
		expect(() =>
			pgSql(
				`find users as u where u.id in (find orders as o where o.total > u.age pick o.user_id)`
			)
		).not.toThrow();
	});

	it("typecheck cross-type dans corrélée : outer alias.field bigint vs literal string refusé", () => {
		expectCode(
			() =>
				pgSql(
					`find users as u where exists (find orders as o where u.id = "abc")`
				),
			"lower_type_mismatch_compare"
		);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Codegen PG : nested SELECT natif
// ═══════════════════════════════════════════════════════════════════════════

describe("codegen PG correlated", () => {
	it("exists corrélée → EXISTS (SELECT... WHERE outer.col = inner.col)", () => {
		const { text } = pgSql(
			`find users as u where exists (find orders as o where o.user_id = u.id)`
		);
		expect(text).toBe(
			`SELECT * FROM "users" AS "u" WHERE EXISTS (SELECT * FROM "orders" AS "o" WHERE "o"."user_id" = "u"."id")`
		);
	});

	it("in (subquery corrélée) → IN (SELECT...)", () => {
		const { text } = pgSql(
			`find users as u where u.id in (find orders as o where o.total > u.age pick o.user_id)`
		);
		expect(text).toBe(
			`SELECT * FROM "users" AS "u" WHERE "u"."id" IN (SELECT "o"."user_id" FROM "orders" AS "o" WHERE "o"."total" > "u"."age")`
		);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Nesting profondeur multiple + scope stack LIFO
// ═══════════════════════════════════════════════════════════════════════════

describe("nested correlated subqueries", () => {
	it("nesting 2 niveaux : subq inner ref outer + outermost", () => {
		// La subq intérieure référence u.id (outer 2 niveaux) et o.id (outer 1 niveau).
		expect(() =>
			pgSql(
				`find users as u where exists (find orders as o where exists (find users as inner where inner.id = u.id and inner.age > o.total))`
			)
		).not.toThrow();
	});
});
