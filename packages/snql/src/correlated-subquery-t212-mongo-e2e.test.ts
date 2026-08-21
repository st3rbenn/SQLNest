/**
 * ADR-024 PM/2 — Sibling parité Mongo pour correlated sub-queries. Mirror
 * de correlated-subquery-t212-e2e.test.ts (oracle PG accepte correlated
 * via ScopeStack + pushdown SELECT). Mongo refuse au planner via
 * `assertUncorrelatedSubqueryForMaterialize` (moved from run.ts, PM/2).
 *
 * Verrous stricts : chaque cas où PG accepte doit produire un refus typé
 * `planner_subquery_unsupported` sur Mongo avec message actionnable.
 * Ticket v3+ : rewrite `$lookup` sub-pipeline natif.
 */

import { describe, expect, it } from "vitest";
import { assertMongoRefused } from "./index";

describe("PM/2 — correlated subquery Mongo refusée systématiquement (v3+)", () => {
	it("exists corrélée simple : refus", () => {
		assertMongoRefused(
			"find users as u where exists (find orders as o where o.user_id = u.id)",
			"planner_subquery_unsupported"
		);
	});

	it("in (corrélée) sur champ outer : refus", () => {
		assertMongoRefused(
			"find users as u where u.id in (find orders as o where o.total > u.age pick o.user_id)",
			"planner_subquery_unsupported"
		);
	});

	it("not exists corrélée : refus", () => {
		assertMongoRefused(
			"find users as u where not exists (find orders as o where o.user_id = u.id)",
			"planner_subquery_unsupported"
		);
	});

	it("corrélée dans un aggregate having : refus", () => {
		// having qui référence outer via subquery corrélée. Fires même via aggregate.having walker.
		assertMongoRefused(
			"find users as u group by u.id having count(*) > 0 and exists (find orders as o where o.user_id = u.id) pick u.id",
			"planner_subquery_unsupported"
		);
	});

	it("corrélée 2 niveaux (inner ref outermost) : refus", () => {
		assertMongoRefused(
			"find users as u where exists (find orders as o where exists (find items as i where i.tag = u.name))",
			"planner_subquery_unsupported"
		);
	});

	it("message inclut l'alias outer référencé (diagnostic actionnable)", () => {
		const err = assertMongoRefused(
			"find users as u where exists (find orders as o where o.user_id = u.id)",
			"planner_subquery_unsupported"
		);
		expect(err.message).toContain("u.<col>");
		expect(err.message).toContain("outer");
	});

	it("suggère le contournement 'with one' + let dans le message", () => {
		const err = assertMongoRefused(
			"find users as u where u.id in (find orders as o where o.total > u.age pick o.user_id)",
			"planner_subquery_unsupported"
		);
		expect(err.message).toMatch(/with one|let/);
	});
});
