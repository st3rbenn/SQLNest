import { describe, expect, it } from "vitest";
import { SnqlError } from "../../diagnostics";
import {
	PLANNER_ERROR_CODES,
	type PlannerErrorCode,
	plannerError
} from "./registry";

describe("planner errors registry (ADR-024 D13)", () => {
	it("plannerError construit un SnqlError avec code typé", () => {
		const err = plannerError(
			"planner_transaction_unsupported",
			"tx non supportée sur mongo standalone"
		);
		expect(err).toBeInstanceOf(SnqlError);
		expect(err.code).toBe("planner_transaction_unsupported");
		expect(err.message).toBe("tx non supportée sur mongo standalone");
		expect(err.span).toBeUndefined();
	});

	it("plannerError propage le span", () => {
		const span = {
			start: { offset: 5, line: 1, column: 6 },
			end: { offset: 12, line: 1, column: 13 }
		};
		const err = plannerError(
			"planner_subquery_unsupported",
			"subquery mongo",
			span
		);
		expect(err.span).toEqual(span);
	});

	it("PLANNER_ERROR_CODES inclut tous les codes de l'union type", () => {
		// Sonde une poignée de codes clés du registre. Si l'un manque, TypeScript
		// laisse passer (any string), c'est le runtime qui l'attrape ici — même
		// stratégie que les registres existants (KEYWORDS, CAST_TARGETS).
		const requiredCodes: readonly PlannerErrorCode[] = [
			"planner_no_scan",
			"planner_subquery_unsupported",
			"planner_correlated_subquery_in_cte_binding_unsupported",
			"planner_let_unsupported",
			"planner_cte_body_join_mongo_unsupported",
			"planner_mongo_cte_write_requires_txn",
			"planner_transaction_unsupported",
			"planner_savepoint_mongo_unsupported",
			"planner_write_join_unsupported",
			"planner_insert_select_unsupported",
			"planner_mongo_insert_select_requires_txn",
			"planner_mongo_json_contains_nested_unsupported",
			"planner_mongo_version_capability_missing",
			"planner_mongo_perf_non_indexable"
		];
		for (const code of requiredCodes) {
			expect(PLANNER_ERROR_CODES.has(code)).toBe(true);
		}
	});

	it("PLANNER_ERROR_CODES contient au moins les 18 codes existants + placeholders PM/2-8", () => {
		// Verrou anti-régression : ne jamais retirer un code du registre sans
		// une PR qui retire aussi son usage dans le code base.
		expect(PLANNER_ERROR_CODES.size).toBeGreaterThanOrEqual(26);
	});
});
