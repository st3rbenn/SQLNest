import { SnqlError } from "../../diagnostics";
import type { Span } from "../../lexer/token";

/**
 * Registre unifié des codes d'erreur planner (ADR-024 D13). Union type figée
 * qui liste les codes émis par le planner aujourd'hui + les placeholders des
 * refus à introduire en PM/2..PM/8. Sert d'oracle typé : toute PR qui ajoute
 * un code planner_* doit l'ajouter ici sinon TypeScript refuse le call à
 * `plannerError`.
 *
 * Convention nommage : `<phase>_<feature>_<engine>_<verb>` — cohérent avec
 * l'existant (ex. `planner_agg_unique_mongo_unsupported_sum_avg`).
 */
export type PlannerErrorCode =
	// Structurel — capacités et planner core
	| "planner_no_scan"
	| "planner_no_scan_capability"
	| "planner_empty_pushdown"
	| "planner_unpushable"
	| "planner_scan_compensation"
	| "planner_unsupported_function"
	// Cast
	| "planner_cast_target_unsupported"
	| "planner_cast_from_jsonb_unsupported"
	// Aggregates
	| "planner_agg_bare_field_needs_group"
	| "planner_agg_unique_mongo_unsupported_sum_avg"
	// JSON
	| "planner_json_get_compare_ambiguous"
	// Subquery / correlated
	| "planner_subquery_unsupported"
	// PM/2 — refus dédié D16 correlated dans binding CTE (invisible sans code
	// dédié : élargit planner_subquery_unsupported avec un message actionnable)
	| "planner_correlated_subquery_in_cte_binding_unsupported"
	// CTE / let
	| "planner_let_unsupported"
	// PM/3 — refus dédié D17 join CTE↔collection Mongo v1 (materializeLet
	// impose body scan direct — refuser proprement au lieu de EngineExecutionError)
	| "planner_cte_body_join_mongo_unsupported"
	// PM/3 — refus D18 #18 CTE + body write nécessite session tx snapshot isolation
	| "planner_mongo_cte_write_requires_txn"
	// Mutations
	| "planner_upsert_unsupported"
	| "planner_write_join_unsupported"
	| "planner_insert_select_unsupported"
	// PM/5 — refus D19 insert-select Mongo hors session tx (Mongo <5.0 replica set)
	| "planner_mongo_insert_select_requires_txn"
	// Transactions / savepoints
	| "planner_transaction_unsupported"
	// PM/7 — refus D5 savepoint Mongo au planner (aujourd'hui refusé tardivement
	// au codegen dans flattenMongoTransactionBody — incohérent doctrine T2/11-15)
	| "planner_savepoint_mongo_unsupported"
	// Introspect
	| "planner_introspect_unsupported"
	// PM/7 — refus D18 #19 json_contains nested (flat scalar accepté via $setIsSubset)
	| "planner_mongo_json_contains_nested_unsupported"
	// D3 — capability-probe driver Mongo au bootstrap ; refus typé si le driver
	// probe ne trouve pas la feature requise (Mongo <4.2 pipeline update / $merge,
	// Mongo <5.0 $merge in tx). Suffixé du nom de feature manquante.
	| "planner_mongo_version_capability_missing"
	// D9 — diagnostic non-bloquant (émis comme warning structuré, pas throw).
	// Émis par le planner pour $lookup correlated non-indexé, $expr+$convert
	// dans predicate write, pipeline update sur join key non-indexée.
	| "planner_mongo_perf_non_indexable";

/**
 * Construit un `SnqlError` avec un code typé du registre. Utiliser à la place
 * de `new SnqlError(msg, "planner_..." as string, span)` pour bénéficier de la
 * vérification exhaustive TypeScript.
 */
export function plannerError(
	code: PlannerErrorCode,
	message: string,
	span?: Span
): SnqlError {
	return new SnqlError(message, code, span);
}

/**
 * Set typé de tous les codes du registre — utilisable pour vérifier au
 * runtime qu'un code inconnu n'est pas silencieusement introduit ailleurs.
 * Consommé par le test unit du registre.
 */
export const PLANNER_ERROR_CODES: ReadonlySet<PlannerErrorCode> =
	new Set<PlannerErrorCode>([
		"planner_no_scan",
		"planner_no_scan_capability",
		"planner_empty_pushdown",
		"planner_unpushable",
		"planner_scan_compensation",
		"planner_unsupported_function",
		"planner_cast_target_unsupported",
		"planner_cast_from_jsonb_unsupported",
		"planner_agg_bare_field_needs_group",
		"planner_agg_unique_mongo_unsupported_sum_avg",
		"planner_json_get_compare_ambiguous",
		"planner_subquery_unsupported",
		"planner_correlated_subquery_in_cte_binding_unsupported",
		"planner_let_unsupported",
		"planner_cte_body_join_mongo_unsupported",
		"planner_mongo_cte_write_requires_txn",
		"planner_upsert_unsupported",
		"planner_write_join_unsupported",
		"planner_insert_select_unsupported",
		"planner_mongo_insert_select_requires_txn",
		"planner_transaction_unsupported",
		"planner_savepoint_mongo_unsupported",
		"planner_introspect_unsupported",
		"planner_mongo_json_contains_nested_unsupported",
		"planner_mongo_version_capability_missing",
		"planner_mongo_perf_non_indexable"
	]);
