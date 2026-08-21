/**
 * ADR-024-A PA/1 — Sibling parité Mongo pour correlated sub-queries. Mirror
 * de correlated-subquery-t212-e2e.test.ts (oracle PG accepte correlated via
 * ScopeStack + pushdown SELECT). Mongo accepte désormais via lift-lookup
 * ($lookup{from, let, pipeline, as} — 5.0+) en remplacement du refus PM/2
 * (assertUncorrelatedSubqueryForMaterialize).
 *
 * Verrous shape : chaque cas produit exactement la séquence attendue [$lookup,
 * $match, $unset]. Restrictions MVP hors-scope conservées (nested v3+,
 * disjonction OR/NOT/case, sub-find complexe) — refus typés dédiés.
 */

import { describe, expect, it } from "vitest";
import { assertMongoPipeline, assertMongoRefused } from "./index";

describe("PA/1 — correlated exists lift-lookup", () => {
	it("exists corrélée : $lookup + $match ne empty + $unset", () => {
		const pipeline = assertMongoPipeline(
			"find users as u where exists (find orders as o where o.user_id = u.id)"
		);
		expect(pipeline).toEqual([
			{
				$lookup: {
					from: "orders",
					let: { outer_id: "$id" },
					pipeline: [
						{
							$match: {
								$expr: { $eq: ["$user_id", "$$outer_id"] }
							}
						}
					],
					as: "__sq_0"
				}
			},
			{ $match: { __sq_0: { $ne: [] } } },
			{ $unset: ["__sq_0"] }
		]);
	});

	it("not exists corrélée : $match eq empty", () => {
		const pipeline = assertMongoPipeline(
			"find users as u where not exists (find orders as o where o.user_id = u.id)"
		);
		expect(pipeline[1]).toEqual({ $match: { __sq_0: { $eq: [] } } });
	});
});

describe("PA/1 — correlated `in (subq pick col)` lift-lookup", () => {
	it("in (correlated pick col) : $lookup + $expr $in + $unset", () => {
		const pipeline = assertMongoPipeline(
			"find users as u where u.id in (find orders as o where o.total > u.age pick o.user_id)"
		);
		expect(pipeline).toEqual([
			{
				$lookup: {
					from: "orders",
					let: { outer_age: "$age" },
					pipeline: [
						{
							$match: {
								$expr: { $gt: ["$total", "$$outer_age"] }
							}
						},
						{ $project: { _id: 0, user_id: 1 } }
					],
					as: "__sq_0"
				}
			},
			{
				$match: {
					$expr: { $in: ["$id", "$__sq_0.user_id"] }
				}
			},
			{ $unset: ["__sq_0"] }
		]);
	});
});

describe("PA/1 — correlated combinée avec AND top-level", () => {
	it("where compare AND exists corrélée : predicate résiduel + match addition", () => {
		const pipeline = assertMongoPipeline(
			'find users as u where u.email = "x" and exists (find orders as o where o.user_id = u.id)'
		);
		const matchStage = pipeline[1] as { $match: Record<string, unknown> };
		expect(matchStage.$match).toEqual({
			$and: [{ email: { $eq: "x" } }, { __sq_0: { $ne: [] } }]
		});
	});
});

describe("PA/1 — verrous MVP refus explicites", () => {
	it("correlated sous OR : refus disjunction_v3", () => {
		const err = assertMongoRefused(
			'find users as u where u.email = "x" or exists (find orders as o where o.user_id = u.id)',
			"planner_correlated_subquery_in_disjunction_v3"
		);
		expect(err.message).toContain("OR/NOT/case");
	});

	it("correlated 2 niveaux (inner ref outermost) : refus nested_v3", () => {
		const err = assertMongoRefused(
			"find users as u where exists (find orders as o where exists (find items as i where i.tag = u.name))",
			"planner_correlated_subquery_nested_v3"
		);
		expect(err.message).toContain("MVP");
	});

	it("correlated avec sort dans le sub-find : refus complex_v3", () => {
		const err = assertMongoRefused(
			"find users as u where exists (find orders as o where o.user_id = u.id sort o.total desc)",
			"planner_correlated_subquery_complex_v3"
		);
		expect(err.message).toContain("MVP");
	});

	it("correlated avec limit dans le sub-find : refus complex_v3", () => {
		assertMongoRefused(
			"find users as u where exists (find orders as o where o.user_id = u.id take 5)",
			"planner_correlated_subquery_complex_v3"
		);
	});

	it("message inclut l'alias outer référencé pour nested", () => {
		const err = assertMongoRefused(
			"find users as u where exists (find orders as o where exists (find items as i where i.tag = u.name))",
			"planner_correlated_subquery_nested_v3"
		);
		expect(err.message).toContain("'u'");
	});
});

describe("PA/1 — correlated dans aggregate having (MVP hors-scope)", () => {
	it("having correlated : refus complex_v3 (lift-lookup câblé sur where uniquement)", () => {
		const err = assertMongoRefused(
			"find users as u group by u.id having count(*) > 0 and exists (find orders as o where o.user_id = u.id) pick u.id",
			"planner_correlated_subquery_complex_v3"
		);
		expect(err.message).toContain("having");
	});
});
