/**
 * Plugin `07-backend-proxy` — décore `fastify.backendProxy`, la fabrique
 * qui envoie des reqs signées au CLI via le WS existant (Bloc B.3).
 *
 * Dépend de :
 *   - `05-tunnels` : `fastify.tunnelRegistry` (routing des frames).
 *   - `06-backend-identity` : `fastify.backendKeypair` (signature Ed25519).
 *
 * `onClose` : dispose du proxy pour cleanup des pendings + subscribers.
 */

import fp from "fastify-plugin";
import {
	type BackendProxy,
	createBackendProxy
} from "../domains/tunnels/backend-proxy";

declare module "fastify" {
	interface FastifyInstance {
		backendProxy: BackendProxy;
	}
}

export default fp(
	async (fastify) => {
		const proxy = createBackendProxy({
			registry: fastify.tunnelRegistry,
			backendKeypair: fastify.backendKeypair
		});
		fastify.decorate("backendProxy", proxy);
		fastify.addHook("onClose", async () => {
			proxy.dispose();
		});
	},
	{
		name: "07-backend-proxy",
		dependencies: ["05-tunnels", "06-backend-identity"]
	}
);
