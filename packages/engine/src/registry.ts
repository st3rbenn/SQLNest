import type { EngineAdapter } from "./adapter";
import { UnknownEngineError } from "./errors";
import { mongoAdapter } from "./mongo/adapter";
import { mssqlAdapter } from "./mssql/adapter";
import { postgresAdapter } from "./postgres/adapter";

const REGISTRY: Readonly<Record<string, EngineAdapter>> = {
	postgres: postgresAdapter,
	mongodb: mongoAdapter,
	mssql: mssqlAdapter
};

/** Adapter d'un moteur par identifiant, ou `undefined` si non enregistré. */
export function getAdapter(engine: string): EngineAdapter | undefined {
	return Object.hasOwn(REGISTRY, engine) ? REGISTRY[engine] : undefined;
}

/** Comme {@link getAdapter} mais lève {@link UnknownEngineError} si absent. */
export function requireAdapter(engine: string): EngineAdapter {
	const adapter = getAdapter(engine);
	if (adapter === undefined) {
		throw new UnknownEngineError(engine);
	}
	return adapter;
}

/** Identifiants des moteurs enregistrés. */
export function registeredEngines(): readonly string[] {
	return Object.keys(REGISTRY);
}
