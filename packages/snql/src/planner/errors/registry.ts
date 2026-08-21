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
	// PA/7 (ADR-024-A) — cast(<dynamic expr> as json) sur Mongo. Le lower parse
	// les string literals au compile-time ; les operands non-literal (field/call
	// /cast) restent no-op silent PM/6 (BSON = JSON natif). Le codegen mongo
	// refuse quand l'operand est CLAIREMENT un string (post-cast(_ as text)),
	// pour éviter le trap "cast à runtime silent" documenté D8.
	| "planner_mongo_cast_str_to_json_dynamic_v3"
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
	// PA/1 (ADR-024-A) — correlated subquery Mongo liftée via $lookup{let,pipeline}
	// (5.0+) : MVP accepte 1 outer field ref sur 1 niveau, refuse les patterns
	// v3+ (nested 2+ niveaux, disjonction OR/NOT, sub-find complexe).
	| "planner_correlated_subquery_nested_v3"
	| "planner_correlated_subquery_in_disjunction_v3"
	| "planner_correlated_subquery_complex_v3"
	// PA/4 (ADR-024-A) — cast dans WHERE d'un update/delete Mongo. Le codegen
	// route vers pipeline update $expr+$convert (4.2+) SAUF pour les casts type
	// coercitifs ambigus : bool/date/timestamp. Ces cibles diffèrent structurellement
	// entre PG (parse strict) et Mongo ($convert truthy / ISO 8601 permissif),
	// donc refus au planner pour éviter silent-corruption sur delete/update.
	| "planner_mongo_write_cast_coercive_v3"
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
	// PM/5 — refus D19-revised (2026-08-21 E2E chinook-mongo) : insert-select
	// via $merge NE PEUT PAS s'exécuter DANS une session tx Mongo (contrainte
	// driver toutes versions 4.2+). Refus si dans transaction { … } block.
	| "planner_mongo_insert_select_in_txn_forbidden"
	// Ancien code D19 original ("tx obligatoire") — gardé le temps de purger
	// les tests qui référencent l'ancienne sémantique.
	| "planner_mongo_insert_select_requires_txn"
	// Transactions / savepoints
	| "planner_transaction_unsupported"
	// PM/7 — refus D5 savepoint Mongo au planner (aujourd'hui refusé tardivement
	// au codegen dans flattenMongoTransactionBody — incohérent doctrine T2/11-15)
	| "planner_savepoint_mongo_unsupported"
	// PA/5 (ADR-024-A) FLAGSHIP — savepoint Mongo via compensation logique
	// in-session (snapshot pre-write + inverse ops sur erreur). MVP accepte
	// INSERT/UPDATE/DELETE simples ; refuse patterns non-analysables :
	| "planner_savepoint_body_opaque_raw"
	| "planner_savepoint_nested_v3"
	| "planner_savepoint_body_write_join_v3"
	| "planner_savepoint_body_insert_select_v3"
	| "planner_savepoint_body_upsert_v3"
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
		"planner_mongo_cast_str_to_json_dynamic_v3",
		"planner_agg_bare_field_needs_group",
		"planner_agg_unique_mongo_unsupported_sum_avg",
		"planner_json_get_compare_ambiguous",
		"planner_subquery_unsupported",
		"planner_correlated_subquery_in_cte_binding_unsupported",
		"planner_correlated_subquery_nested_v3",
		"planner_correlated_subquery_in_disjunction_v3",
		"planner_correlated_subquery_complex_v3",
		"planner_mongo_write_cast_coercive_v3",
		"planner_let_unsupported",
		"planner_cte_body_join_mongo_unsupported",
		"planner_mongo_cte_write_requires_txn",
		"planner_upsert_unsupported",
		"planner_write_join_unsupported",
		"planner_insert_select_unsupported",
		"planner_mongo_insert_select_requires_txn",
		"planner_mongo_insert_select_in_txn_forbidden",
		"planner_transaction_unsupported",
		"planner_savepoint_mongo_unsupported",
		"planner_savepoint_body_opaque_raw",
		"planner_savepoint_nested_v3",
		"planner_savepoint_body_write_join_v3",
		"planner_savepoint_body_insert_select_v3",
		"planner_savepoint_body_upsert_v3",
		"planner_introspect_unsupported",
		"planner_mongo_json_contains_nested_unsupported",
		"planner_mongo_version_capability_missing",
		"planner_mongo_perf_non_indexable"
	]);
