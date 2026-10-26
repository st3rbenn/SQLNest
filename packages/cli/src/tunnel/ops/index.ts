import type { Connection } from "@sqlnest/engine";
import type { SchemaModel } from "@sqlnest/snql";
import type {
	TunnelOp,
	TunnelOpName,
	TunnelOpResult
} from "@sqlnest/tunnel-protocol";
import { openConnectionForTunnel } from "../../services/engine";
import { applySchemaChangeOp } from "./apply-schema-change";
import { introspectOp } from "./introspect";
import type { OpDefinition, SchemaCache } from "./op";
import { pingOp } from "./ping";
import { projectStatusOp } from "./project-status";
import { runSnqlOp } from "./run-snql";

/** Un handler par op du contrat : une op sans handler ne compile pas. */
const OPS: { readonly [K in TunnelOpName]: OpDefinition<K> } = {
	ping: pingOp,
	introspect: introspectOp,
	runSnql: runSnqlOp,
	projectStatus: projectStatusOp,
	applySchemaChange: applySchemaChangeOp
};

/** Cache de schéma d'une connexion, pour la durée du process CLI. */
export function createSchemaCache(): SchemaCache {
	let cached: SchemaModel | undefined;
	return {
		get: () => cached,
		set: (schema) => {
			cached = schema;
		},
		invalidate: () => {
			cached = undefined;
		}
	};
}

/**
 * Exécute une op reçue du tunnel sur la base locale de `connectionName`.
 * Chaque op ouvre sa connexion à la demande et la ferme en sortant (pas de
 * pool partagé : un ajout de v1.1 si le débit l'exige). Les erreurs
 * remontent à l'appelant, qui les traduit en réponse.
 */
export async function dispatchOp(
	op: TunnelOp,
	target: {
		readonly connectionName: string;
		readonly env: NodeJS.ProcessEnv;
		readonly schema: SchemaCache;
		/** Ouverture de la connexion (test) ; défaut : la DSN locale. */
		readonly open?: typeof openConnectionForTunnel;
	}
): Promise<TunnelOpResult> {
	const definition = OPS[op.op] as OpDefinition<TunnelOpName> | undefined;
	if (definition === undefined) return { ok: false, error: "op inconnue" };
	const open = target.open ?? openConnectionForTunnel;
	let conn: Connection | undefined;
	try {
		const data = await definition.run(op as never, {
			connectionName: target.connectionName,
			env: target.env,
			schema: target.schema,
			connection: async () => {
				conn ??= await open(target.connectionName, target.env);
				return conn;
			}
		});
		return { ok: true, data };
	} finally {
		await conn?.close();
	}
}
