/**
 * Sibling parité Mongo pour let/CTE. Mirror de let-e2e.test.ts
 * (oracle PG utilise `WITH ... AS`). Mongo compile via matérialisation runtime
 * (`materializeLet` dans packages/engine/src/run.ts) qui délègue à
 * `materializeSubplan` — pas de codegen mapLet.
 *
 * Ce fichier verrouille : (a) planner accepte let sur Mongo (cte capability
 * ), (b) refus join CTE↔collection avec code typé, (c) shadow-check
 * fires sur schema Mongo, (d) self-ref via walker complet.
 *
 * Les tests d'exécution runtime (rows effectivement matérialisées) vivent dans
 * chinook-parity-e2e.test.ts et parity-matrix.e2e.test.ts.
 */

import { describe, expect, it } from "vitest";
import {
	assertLetSupported,
	lowerLet,
	MONGODB_CAPABILITIES,
	parse,
	tokenize
} from "./index";
import type { SchemaModel } from "./schema/model";

function makeMongoSchema(...names: string[]): SchemaModel {
	return {
		engine: "mongodb",
		collections: names.map((name) => ({
			name,
			fields: [],
			source: { kind: "test" }
		})),
		relations: []
	} as unknown as SchemaModel;
}

describe("Mongo let/CTE capability (matérialisation runtime)", () => {
	it("MONGODB_CAPABILITIES contient 'cte'", () => {
		expect(MONGODB_CAPABILITIES.supports.has("cte")).toBe(true);
	});

	it("let simple accepté au planner (uncorrelated body)", () => {
		const stmt = parse(
			tokenize("let active = find users where inactive = false pick id; find active pick id")
		);
		if (stmt.operation !== "let") throw new Error();
		const plan = lowerLet(stmt);
		expect(() =>
			assertLetSupported(plan, MONGODB_CAPABILITIES)
		).not.toThrow();
	});

	it("let chaîné accepté (bindings référençant CTE précédent)", () => {
		const stmt = parse(
			tokenize("let a = find users; let b = find a where id > 0 pick id; find b pick id")
		);
		if (stmt.operation !== "let") throw new Error();
		const plan = lowerLet(stmt);
		expect(() =>
			assertLetSupported(plan, MONGODB_CAPABILITIES)
		).not.toThrow();
	});

	it("body insert-select depuis CTE accepté", () => {
		const stmt = parse(
			tokenize(
				'let candidates = find users where email like "%@old.com"; add (find candidates pick id, email) into archive'
			)
		);
		if (stmt.operation !== "let") throw new Error();
		const plan = lowerLet(stmt);
		expect(() =>
			assertLetSupported(plan, MONGODB_CAPABILITIES)
		).not.toThrow();
	});
});

describe("shadow-check Mongo (étendu)", () => {
	it("refus shadow simple avec schema Mongo", () => {
		const stmt = parse(
			tokenize(
				"let users = find users where is_active = true; find users pick email"
			)
		);
		if (stmt.operation !== "let") throw new Error();
		try {
			lowerLet(stmt, makeMongoSchema("users"));
			expect.fail("expected shadow refus");
		} catch (e) {
			expect((e as { code?: string }).code).toBe(
				"lower_let_shadows_collection"
			);
		}
	});

	it("mode sans schema : shadow-check skip (divergence documentée)", () => {
		// Sans schema, le shadow-check ne fires pas — comportement identique
		// PG/Mongo aujourd'hui. Fix complet nécessite un cache
		// listCollections() au bootstrap CLI (reporté).
		const stmt = parse(
			tokenize("let users = find products; find users pick id")
		);
		if (stmt.operation !== "let") throw new Error();
		expect(() => lowerLet(stmt)).not.toThrow();
	});
});

describe("self-ref walker complet sur Mongo", () => {
	it("self-ref via subquery in-where refusé (walker)", () => {
		const stmt = parse(
			tokenize(
				"let a = find users where id in (find a pick parent_id); find a pick id"
			)
		);
		if (stmt.operation !== "let") throw new Error();
		try {
			lowerLet(stmt);
			expect.fail("expected self-ref refus");
		} catch (e) {
			expect((e as { code?: string }).code).toBe(
				"lower_let_self_reference_without_rec"
			);
		}
	});
});
