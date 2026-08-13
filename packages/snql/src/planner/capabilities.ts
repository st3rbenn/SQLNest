import { SNQL_FUNCTIONS, type EngineName } from "../functions";
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
}

function caps(
	engine: EngineName,
	supported: readonly Capability[],
	castTargets: readonly CastTarget[]
): Capabilities {
	// Baseline Mongo 5.0+ assumée pour les fonctions sprint 3
	// ($dateTrunc / $dateAdd / $dateDiff / $replaceAll). Ticket futur :
	// introduire Capabilities.mongoServerVersion pour version gating côté
	// planner et rejeter à la compilation plutôt qu'au runtime cryptique.
	return {
		engine,
		supports: new Set(supported),
		functions: SNQL_FUNCTIONS.forEngine(engine),
		castTargets: new Set(castTargets)
	};
}

/** Relationnel complet (lecture). Tous les casts canoniques supportés. */
export const POSTGRES_CAPABILITIES: Capabilities = caps(
	"postgres",
	["scan", "filter", "project", "join", "aggregate", "sort", "paginate", "mutate"],
	["int", "float", "text", "bool", "date", "timestamp", "json"]
);

/**
 * Document : join = $lookup, agrégation via pipeline. `cast(_ as json)` refusé
 * car les documents Mongo sont déjà des BSON — aucun cast nécessaire.
 */
export const MONGODB_CAPABILITIES: Capabilities = caps(
	"mongodb",
	["scan", "filter", "project", "join", "aggregate", "sort", "paginate", "mutate"],
	["int", "float", "text", "bool", "date", "timestamp"]
);

/**
 * Clé-valeur (façon Redis) : sait scanner et filtrer, mais NI trier, NI projeter,
 * NI paginer, NI joindre côté serveur → ces opérateurs déclenchent la compensation.
 * Fonctions : sprint T2/5 introduit le dispatch registre côté runtime — la liste
 * `SNQL_FUNCTIONS.forEngine("kv")` correspond aux entrées avec `engines.kv`
 * déclaré (aujourd'hui : if/nullif/greatest/least). Toute autre fonction
 * déclenche `planner_unsupported_function`. Cast : uniquement scalaires
 * primitifs (JS n'a pas de parser portable pour `date`/`timestamp`/`json`
 * en compensation stricte).
 */
export const KV_CAPABILITIES: Capabilities = caps(
	"kv",
	["scan", "filter", "mutate"],
	["int", "float", "text", "bool"]
);

const REGISTRY: Readonly<Record<string, Capabilities>> = {
	postgres: POSTGRES_CAPABILITIES,
	mongodb: MONGODB_CAPABILITIES,
	kv: KV_CAPABILITIES
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
