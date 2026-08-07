/**
 * Plugin backend-identity — dérive la keypair backend une fois au boot
 * depuis `AUTH_SECRET` et la décore sur `fastify.backendKeypair`.
 *
 * Un consommateur (routes proxy, sendReqToCli) l'utilise pour signer
 * les frames envoyées au CLI. La pubkey est aussi exposée via la route
 * publique `GET /api/backend/pubkey`.
 *
 * Ordre `06-` = après `05-tunnels` qui décore `fastify.tunnelRegistry`
 * (le proxy tunnel Bloc B.3 combinera les deux).
 */

import fp from "fastify-plugin";
import {
	type BackendKeypair,
	deriveBackendKeypair
} from "../domains/backend-identity/keypair";

declare module "fastify" {
	interface FastifyInstance {
		backendKeypair: BackendKeypair;
	}
}

export default fp(
	async (fastify) => {
		const kp = deriveBackendKeypair(process.env.AUTH_SECRET);
		fastify.decorate("backendKeypair", kp);
	},
	{
		name: "06-backend-identity",
		dependencies: ["05-tunnels"]
	}
);
