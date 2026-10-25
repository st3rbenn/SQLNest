import type { Connection } from "@sqlnest/engine";
import type { SchemaModel } from "@sqlnest/snql";
import type {
	TunnelOpData,
	TunnelOpName,
	TunnelOpOf
} from "@sqlnest/tunnel-protocol";

/** Schéma introspecté d'une connexion, gardé entre les ops du process. */
export interface SchemaCache {
	get(): SchemaModel | undefined;
	set(schema: SchemaModel): void;
	invalidate(): void;
}

/** Ce qu'une op reçoit pour agir sur la base locale servie par le tunnel. */
export interface OpContext {
	readonly connectionName: string;
	readonly env: NodeJS.ProcessEnv;
	/** Connexion à la base, ouverte au premier appel, fermée à la fin de l'op. */
	connection(): Promise<Connection>;
	readonly schema: SchemaCache;
}

/** Handler d'une op du contrat partagé (`@sqlnest/tunnel-protocol`). */
export interface OpDefinition<K extends TunnelOpName> {
	readonly name: K;
	readonly run: (
		req: TunnelOpOf<K>,
		ctx: OpContext
	) => Promise<TunnelOpData<K>>;
}

export function defineOp<K extends TunnelOpName>(
	definition: OpDefinition<K>
): OpDefinition<K> {
	return definition;
}
