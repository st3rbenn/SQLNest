/**
 * + Sibling parité Mongo pour sub-queries
 * uncorrelated (requalifié) et correlated liftées. Mirror de
 * subquery-e2e.test.ts (oracle PG) : mêmes SNQL, planner Mongo ACCEPTE.
 *
 * Le shape du pipeline Mongo post-matérialisation dépend des rows exécutées
 * en runtime — non testable ici sans Connection (couvert par les tests
 * d'intégration adapter.int.test.ts et parity-matrix.e2e.test.ts en).
 * Ici on verrouille uniquement l'acceptance côté planner + verrous refus
 * MVP hors-scope (nested v3+).
 */

import { describe, expect, it } from "vitest";
import { assertMongoRefused, MONGODB_CAPABILITIES, planFor } from "./index";

describe("subquery uncorrelated Mongo acceptée (requalifié)", () => {
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

describe("subquery correlated Mongo acceptée via lift-lookup", () => {
	it("exists corrélée acceptée au planner (lift-lookup $lookup{let,pipeline})", () => {
		expect(() =>
			planFor(
				"find users as u where exists (find orders as o where o.user_id = u.id)",
				"mongodb"
			)
		).not.toThrow();
	});

	it("in (subquery corrélée) acceptée au planner", () => {
		expect(() =>
			planFor(
				"find users as u where u.id in (find orders as o where o.total > u.age pick o.user_id)",
				"mongodb"
			)
		).not.toThrow();
	});

	it("not exists corrélée acceptée au planner", () => {
		expect(() =>
			planFor(
				"find users as u where not exists (find orders as o where o.user_id = u.id)",
				"mongodb"
			)
		).not.toThrow();
	});

	it("correlated nested (2 niveaux) : refus planner_correlated_subquery_nested_v3", () => {
		const err = assertMongoRefused(
			"find users as u where exists (find orders as o where exists (find items as i where i.order_id = o.id and i.tag = u.name))",
			"planner_correlated_subquery_nested_v3"
		);
		expect(err.message).toContain("MVP");
	});
});
