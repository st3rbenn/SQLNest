/**
 * Fixtures de cas SNQL pour la parity-matrix.
 *
 * Chaque case = un SNQL source + un ensemble d'engines qui doivent le
 * COMPILER (planner accepte + codegen produit un native query sans throw).
 * Les cases divergents (documentés dans divergences-mongo-vs-pg.ts) portent
 * un `divergenceCode` référençant le registre ; le runner CI (à venir,
 * requiert Docker) skippe la comparaison bit-à-bit pour ces cas.
 *
 * Consommé par :
 *  - parity-cases.test.ts — vérifie compile OK pour tous les engines listés
 *    dans `.engines`, offline, à chaque test run.
 *  - parity-matrix.e2e.test.ts (requiert Docker) — exécute chaque case sur
 *    les 2 drivers avec seed identique + diff bit-à-bit.
 *
 * Contrat : ajouter un cas ici verrouille la parity — toute PR qui casse
 * la compilation pour un engine listé fail CI.
 */

export type ParityEngine = "postgres" | "mongodb";

export interface ParityCase {
	readonly id: string;
	readonly source: string;
	readonly engines: readonly ParityEngine[];
	/**
	 * Code de divergence (registre divergences-mongo-vs-pg.ts) si le résultat
	 * runtime diffère entre les engines — le bit-à-bit diff est skippé pour
	 * ce cas, mais la compilation reste vérifiée.
	 */
	readonly divergenceCode?: string;
	/**
	 * Refus attendu sur un engine spécifique (v3+ hors scope). Format :
	 * `{ engine: "mongodb", code: "planner_subquery_unsupported" }`.
	 */
	readonly expectedRefusal?: {
		readonly engine: ParityEngine;
		readonly code: string;
	};
	/**
	 * Marque un case comme runtime-materialized sur certains engines (ex:
	 * subquery uncorrelated Mongo résolu via materializeSubplan au runtime,
	 * cte let matérialisé). Le codegen unit-test doit skip ces engines —
	 * la vérification bit-à-bit vient de parity-matrix.e2e.test.ts (Docker).
	 */
	readonly runtimeMaterialized?: readonly ParityEngine[];
}

/**
 * fixtures MVP — couvre les grandes familles SNQL. Chaque famille (find,
 * subquery, cte, write-join, insert-select, transaction, upsert, agg) a au
 * moins 1 cas. Sera étendue par selon besoin CI.
 */
export const PARITY_CASES: readonly ParityCase[] = [
	// ─── Lecture de base ────────────────────────────────────────────────
	{
		id: "find-simple",
		source: "find users pick id, email",
		engines: ["postgres", "mongodb"]
	},
	{
		id: "find-where",
		source: "find users where age > 18 pick id",
		engines: ["postgres", "mongodb"]
	},
	{
		id: "find-sort-limit",
		source: "find users sort id desc limit 10",
		engines: ["postgres", "mongodb"]
	},
	// ─── Aggregates ─────────────────────────────────────────────────────
	{
		id: "agg-count-star",
		source: "find orders pick count(*) as n",
		engines: ["postgres", "mongodb"]
	},
	{
		id: "agg-sum-unique",
		source: "find orders pick sum(unique amount) as s",
		engines: ["postgres", "mongodb"]
	},
	{
		id: "agg-group-having",
		source: "find orders group by status having count(*) > 5 pick status, count(*) as n",
		engines: ["postgres", "mongodb"]
	},
	// ─── Joins ──────────────────────────────────────────────────────────
	{
		id: "join-with-one",
		source: "find orders with one users as u on user_id = u.id pick id, u.email",
		engines: ["postgres", "mongodb"]
	},
	// ─── Subquery (uncorrelated OK) ────────────────────────────────
	{
		id: "subquery-in-uncorrelated",
		source: "find users where id in (find orders pick user_id)",
		engines: ["postgres", "mongodb"],
		runtimeMaterialized: ["mongodb"]
	},
	{
		id: "subquery-exists-uncorrelated",
		source: "find users where exists (find orders)",
		engines: ["postgres", "mongodb"],
		runtimeMaterialized: ["mongodb"]
	},
	// correlated liftée en $lookup{let,pipeline} : compile OK
	// sur les 2 engines. Nested 2+ niveaux reste hors scope MVP.
	{
		id: "subquery-correlated-lift-lookup",
		source: "find users as u where exists (find orders as o where o.user_id = u.id)",
		engines: ["postgres", "mongodb"]
	},
	// Verrou refus MVP hors-scope : nested 2+ niveaux
	{
		id: "subquery-correlated-nested-refused-mongo",
		source: "find users as u where exists (find orders as o where exists (find items as i where i.tag = u.name))",
		engines: ["postgres"],
		expectedRefusal: {
			engine: "mongodb",
			code: "planner_correlated_subquery_nested_v3"
		}
	},
	// ─── CTE / let ───────────────────────────────────────────────
	{
		id: "let-basic",
		source: "let active = find users where inactive = false pick id; find active pick id",
		engines: ["postgres", "mongodb"]
	},
	// ─── Write basique (PG only à cause de returning) ───────────────────
	{
		id: "insert-single",
		source: 'add {email: "a@b.c", name: "x"} into users',
		engines: ["postgres", "mongodb"]
	},
	{
		id: "update-simple",
		source: 'update users where id = 1 set is_active = false',
		engines: ["postgres", "mongodb"]
	},
	{
		id: "delete-simple",
		source: "remove from users where id = 1",
		engines: ["postgres", "mongodb"]
	},
	// ─── Write-join ──────────────────────────────────────────────
	{
		id: "write-join-simple",
		source: "update orders with one users as u on user_id = u.id set discount = 0.1",
		engines: ["postgres", "mongodb"]
	},
	// ─── Insert-select ───────────────────────────────────────────
	{
		id: "insert-select-simple",
		source: "add (find users pick id, email) into archive",
		engines: ["postgres", "mongodb"]
	},
	// ─── Transaction (savepoint via compensation logique in-session) ─
	{
		id: "transaction-simple",
		source: "transaction { update users where id = 1 set is_active = false; remove from orders where user_id = 1 }",
		engines: ["postgres", "mongodb"]
	},
	{
		id: "transaction-savepoint-compensation",
		source: "transaction { savepoint sp1 { update users where id = 1 set is_active = false } }",
		engines: ["postgres", "mongodb"]
	},
	{
		id: "transaction-savepoint-nested-refused-mongo",
		source: "transaction { savepoint sp1 { savepoint sp2 { find users pick id } } }",
		engines: ["postgres"],
		expectedRefusal: {
			engine: "mongodb",
			code: "planner_savepoint_nested_v3"
		}
	},
	// ─── Divergences documentées ────────────────────────────────────────
	{
		id: "concat-null-parity-shim",
		source: 'find users pick concat(first_name, " ", last_name) as full_name',
		engines: ["postgres", "mongodb"],
		divergenceCode: "concat_null_parity"
	},
	{
		id: "cast-as-json-noop-mongo",
		source: "find users pick cast(meta as json) as m",
		engines: ["postgres", "mongodb"],
		divergenceCode: "cast_date_timestamp_collapse"
	}
];
