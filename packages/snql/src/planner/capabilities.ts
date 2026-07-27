import type { Capability } from "../ir/plan";

/**
 * Descriptor des capacités d'un moteur. Alimente le planner capability-aware :
 * capacité présente → pushdown ; absente → compensation (ou erreur typée).
 * Voir le vault : `04 - Engines/Capability Matrix`.
 */
export interface Capabilities {
	readonly engine: string;
	readonly supports: ReadonlySet<Capability>;
}

function caps(engine: string, supported: readonly Capability[]): Capabilities {
	return { engine, supports: new Set(supported) };
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
