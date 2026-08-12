import { SNQL_FUNCTIONS } from "../functions";
import type { Capability } from "../ir/plan";

/**
 * Descriptor des capacités d'un moteur. Alimente le planner capability-aware :
 * capacité présente → pushdown ; absente → compensation (ou erreur typée).
 * `functions` = liste des noms canoniques du registre supportés par ce moteur ;
 * un call à une fonction absente lève `planner_unsupported_function`.
 * Voir le vault : `04 - Engines/Capability Matrix`.
 */
export interface Capabilities {
	readonly engine: string;
	readonly supports: ReadonlySet<Capability>;
	readonly functions: ReadonlySet<string>;
}

function caps(engine: string, supported: readonly Capability[]): Capabilities {
	return {
		engine,
		supports: new Set(supported),
		functions:
			engine === "postgres"
				? SNQL_FUNCTIONS.forEngine("postgres")
				: engine === "mongodb"
					? SNQL_FUNCTIONS.forEngine("mongodb")
					: new Set<string>()
	};
}

/** Relationnel complet (lecture). */
export const POSTGRES_CAPABILITIES: Capabilities = caps("postgres", [
	"scan",
	"filter",
	"project",
	"join",
	"aggregate",
	"sort",
	"paginate",
	"mutate"
]);

/** Document : join = $lookup, agrégation via pipeline. */
export const MONGODB_CAPABILITIES: Capabilities = caps("mongodb", [
	"scan",
	"filter",
	"project",
	"join",
	"aggregate",
	"sort",
	"paginate",
	"mutate"
]);

/**
 * Clé-valeur (façon Redis) : sait scanner et filtrer, mais NI trier, NI projeter,
 * NI paginer, NI joindre côté serveur → ces opérateurs déclenchent la compensation.
 * Aucune fonction du registre — un call déclenche `planner_unsupported_function`.
 */
export const KV_CAPABILITIES: Capabilities = caps("kv", [
	"scan",
	"filter",
	"mutate"
]);

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
