import { type EngineName, SNQL_FUNCTIONS } from "../functions";
import type { Capability, CastTarget } from "../ir/plan";

/**
 * Descriptor des capacités d'un moteur. Alimente le planner capability-aware :
 * capacité présente → pushdown ; absente → compensation (ou erreur typée).
 * `functions` = liste des noms canoniques du registre supportés par ce moteur ;
 * un call à une fonction absente lève `planner_unsupported_function`.
 * `castTargets` = types canoniques `cast(x as T)` supportés par ce moteur ;
 * absent → `planner_cast_target_unsupported`.
 * Voir le vault : `04 - Engines/Capability Matrix`.
 */
export interface Capabilities {
	readonly engine: string;
	readonly supports: ReadonlySet<Capability>;
	readonly functions: ReadonlySet<string>;
	readonly castTargets: ReadonlySet<CastTarget>;
	/**
	 * stratégie d'exécution des sub-queries si `supports.has(
	 * "subquery")`. 'native' : pushdown SQL/pipeline natif (PG, SELECT imbriqué).
	 * 'materialize' : runtime via `materializeSubplan` (Mongo, résolution
	 * uncorrelated côté runtime + refus correlated au planner). Absent = pas
	 * de subquery support du tout (KV, refus au planner).
	 */
	readonly subqueryStrategy?: "native" | "materialize";
}

function caps(
	engine: EngineName,
	supported: readonly Capability[],
	castTargets: readonly CastTarget[],
	extras: { readonly subqueryStrategy?: "native" | "materialize" } = {}
): Capabilities {
	// Baseline Mongo 5.0+ assumée pour les fonctions
	// ($dateTrunc / $dateAdd / $dateDiff / $replaceAll). À terme :
	// introduire Capabilities.mongoServerVersion pour version gating côté
	// planner et rejeter à la compilation plutôt qu'au runtime cryptique.
	const base: Capabilities = {
		engine,
		supports: new Set(supported),
		functions: SNQL_FUNCTIONS.forEngine(engine),
		castTargets: new Set(castTargets)
	};
	return extras.subqueryStrategy === undefined
		? base
		: { ...base, subqueryStrategy: extras.subqueryStrategy };
}

/** Relationnel complet (lecture). Tous les casts canoniques supportés.
 * 'subquery' ajouté — sub-queries inline (`in (find...)` /
 * `exists (find ...)`) natives PG (nested SELECT).
 * 'upsert' ajouté — `add {…} into t on conflict (col) [ignore |
 * edit set …]` via `INSERT ... ON CONFLICT` natif PG.
 * 'write-join' + 'insert-select' ajoutés — `update … with one`
 * via `UPDATE ... FROM` et `add (find …) into t` via `INSERT ... SELECT`.
 * 'transaction' ajouté — `transaction { s; s }` bloc atomique
 * via `BEGIN [ISOLATION LEVEL X] / COMMIT / ROLLBACK` + SAVEPOINT natifs. */
export const POSTGRES_CAPABILITIES: Capabilities = caps(
	"postgres",
	[
		"scan",
		"filter",
		"project",
		"join",
		"aggregate",
		"sort",
		"paginate",
		"mutate",
		"subquery",
		"upsert",
		"write-join",
		"insert-select",
		"transaction",
		"introspect",
		"cte",
		"cte-recursive",
		"ddl"
	],
	["int", "float", "text", "bool", "date", "timestamp", "json"],
	{ subqueryStrategy: "native" }
);

/**
 * Document : join = $lookup, agrégation via pipeline. `cast(_ as json)` refusé
 * car les documents Mongo sont déjà des BSON — aucun cast nécessaire.
 * Sprint TxMongo : 'transaction' ajouté — bloc atomique via RS session
 * (startTransaction/commit/abort). Requiert Mongo en replica set (standalone
 * n'accepte pas les transactions).
 * 'subquery' ajouté avec strategy='materialize' — le planner
 * accepte les sub-queries uncorrelated (résolues via `materializeSubplan` au
 * runtime) ; correlated reste refusée au planner via
 * `planner_subquery_unsupported` (dédié pour CTE bindings).
 */
export const MONGODB_CAPABILITIES: Capabilities = caps(
	"mongodb",
	[
		"scan",
		"filter",
		"project",
		"join",
		"aggregate",
		"sort",
		"paginate",
		"mutate",
		"introspect",
		"transaction",
		"upsert",
		"subquery",
		"cte",
		"write-join",
		"insert-select",
		"ddl"
	],
	// item #7 : 'json' ajouté aux castTargets Mongo — cast(x as json)
	// est un no-op côté Mongo (BSON = JSON natif). squiggly INFO éditeur
	// avertira sur `cast(str as json)` (trap type : la string ne sera pas parsée).
	["int", "float", "text", "bool", "date", "timestamp", "json"],
	{ subqueryStrategy: "materialize" }
);

/**
 * Clé-valeur (façon Redis) : sait scanner et filtrer, mais NI trier, NI projeter,
 * NI paginer, NI joindre côté serveur → ces opérateurs déclenchent la compensation.
 * Fonctions : introduit le dispatch registre côté runtime — la liste
 * `SNQL_FUNCTIONS.forEngine("kv")` correspond aux entrées avec `engines.kv`
 * déclaré (aujourd'hui : if/nullif/greatest/least). Toute autre fonction
 * déclenche `planner_unsupported_function`. Cast : uniquement scalaires
 * primitifs (JS n'a pas de parser portable pour `date`/`timestamp`/`json`
 * en compensation stricte).
 */
export const KV_CAPABILITIES: Capabilities = caps(
	"kv",
	// 'aggregate' ajouté — foldAggregate implémenté dans
	// compensate.ts (1 row output N rows avec groupKeys).
	// 'ddl' ajouté — DDL Tier-2 compensated via HSET `namespace:_schema`
	// metadata + PK middleware (D13 ADR-029, jamais refus engine gap).
	["scan", "filter", "mutate", "aggregate", "ddl"],
	["int", "float", "text", "bool"]
);

/**
 * Relationnel T-SQL — chantiers M/3 (lecture) + M/4 (CRUD) : pushdown natif
 * scan/filter/project/join/aggregate/sort/paginate + sub-queries SELECT
 * imbriqués + écritures complètes ('mutate' via OUTPUT ≈ RETURNING, 'upsert'
 * via MERGE WITH (HOLDLOCK), 'write-join' via UPDATE…FROM, 'insert-select',
 * 'transaction' via BEGIN/SAVE TRANSACTION/COMMIT natifs). Les slices
 * suivantes ouvrent le reste : introspect + cte/cte-recursive (M/5), ddl
 * (M/6) — capacité absente = refus planner typé, l'état du chantier reste
 * visible (jamais un silence).
 * `castTargets` sans `json` : T-SQL n'a pas de type json (nvarchar porteur) —
 * un `cast(x as json)` n'aurait pas la sémantique validation/parse PG.
 */
export const MSSQL_CAPABILITIES: Capabilities = caps(
	"mssql",
	[
		"scan",
		"filter",
		"project",
		"join",
		"aggregate",
		"sort",
		"paginate",
		"subquery",
		"mutate",
		"upsert",
		"write-join",
		"insert-select",
		"transaction",
		"introspect",
		"cte",
		"cte-recursive",
		"ddl"
	],
	["int", "float", "text", "bool", "date", "timestamp"],
	{ subqueryStrategy: "native" }
);

const REGISTRY: Readonly<Record<string, Capabilities>> = {
	postgres: POSTGRES_CAPABILITIES,
	mongodb: MONGODB_CAPABILITIES,
	kv: KV_CAPABILITIES,
	mssql: MSSQL_CAPABILITIES
};

/** Capacités d'un moteur par nom, ou `undefined` si inconnu. */
export function capabilitiesFor(engine: string): Capabilities | undefined {
	return Object.hasOwn(REGISTRY, engine) ? REGISTRY[engine] : undefined;
}

export function supports(
	capabilities: Capabilities,
	capability: Capability
): boolean {
	return capabilities.supports.has(capability);
}
