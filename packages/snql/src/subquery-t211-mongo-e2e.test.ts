/**
 * ADR-024 PM/2 — Sibling parité Mongo pour sub-queries uncorrelated. Mirror
 * de subquery-t211-e2e.test.ts (oracle PG) : mêmes SNQL, vérification que
 * le planner Mongo les ACCEPTE désormais (Q2c requalifié, résolution runtime
 * via `materializeSubplan` — packages/engine/src/mongo/materialize.ts).
 *
 * Le shape du pipeline Mongo post-matérialisation dépend des rows exécutées
 * en runtime — non testable ici sans Connection (couvert par les tests
 * d'intégration adapter.int.test.ts et parity-matrix.e2e.test.ts en PM/9).
 * Ici on verrouille uniquement l'acceptance côté planner.
 */

import { describe, expect, it } from "vitest";
import { assertMongoRefused, MONGODB_CAPABILITIES, planFor } from "./index";

describe("PM/2 — subquery uncorrelated Mongo acceptée (Q2c requalifié)", () => {
	it("in (subquery) uncorrelated accepté au planner", () => {
		expect(() =>
			planFor("find u where id in (find t pick uid)", "mongodb")
		).not.toThrow();
	});

	it("exists (subquery) uncorrelated accepté au planner", () => {
		expect(() =>
			planFor("find u where exists (find t)", "mongodb")
		).not.toThrow();
	});

	it("not exists (subquery) uncorrelated accepté au planner", () => {
		expect(() =>
			planFor("find u where not exists (find t)", "mongodb")
		).not.toThrow();
	});

	it("in (subquery) uncorrelated avec projection accepté", () => {
		expect(() =>
			planFor(
				'find users where id in (find orders where status = "active" pick user_id)',
				"mongodb"
			)
		).not.toThrow();
	});

	it("in (subquery) nested uncorrelated accepté", () => {
		// Subquery inner qui ne référence PAS l'outer alias — reste uncorrelated
		// même à 2 niveaux d'imbrication.
		expect(() =>
			planFor(
				"find users where id in (find orders where product_id in (find products pick id) pick user_id)",
				"mongodb"
			)
		).not.toThrow();
	});

	it("MONGODB_CAPABILITIES contient 'subquery' avec strategy='materialize'", () => {
		expect(MONGODB_CAPABILITIES.supports.has("subquery")).toBe(true);
		expect(MONGODB_CAPABILITIES.subqueryStrategy).toBe("materialize");
	});
});

describe("PM/2 — subquery correlated Mongo refusée (v3+ hors scope)", () => {
	it("exists corrélée : refus planner_subquery_unsupported avec message actionnable", () => {
		const err = assertMongoRefused(
			"find users as u where exists (find orders as o where o.user_id = u.id)",
			"planner_subquery_unsupported"
		);
		expect(err.message).toContain("corrélée");
		expect(err.message).toContain("u.<col>");
		expect(err.message).toContain("Contournement");
	});

	it("in (subquery corrélée) : refus planner_subquery_unsupported", () => {
		const err = assertMongoRefused(
			"find users as u where u.id in (find orders as o where o.total > u.age pick o.user_id)",
			"planner_subquery_unsupported"
		);
		expect(err.message).toContain("corrélée");
	});

	it("not exists corrélée : refus planner_subquery_unsupported", () => {
		const err = assertMongoRefused(
			"find users as u where not exists (find orders as o where o.user_id = u.id)",
			"planner_subquery_unsupported"
		);
		expect(err.code).toBe("planner_subquery_unsupported");
	});

	it("correlated nested (2 niveaux) : refus", () => {
		// L'inner ref l'outermost (u) via 2 niveaux — matérialisation impossible.
		const err = assertMongoRefused(
			"find users as u where exists (find orders as o where exists (find items as i where i.order_id = o.id and i.tag = u.name))",
			"planner_subquery_unsupported"
		);
		expect(err.code).toBe("planner_subquery_unsupported");
	});
});
