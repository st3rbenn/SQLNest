/**
 * Plugin backend — registre in-memory des tunnels WS actifs +
 * enregistrement de `@fastify/websocket`.
 *
 * Décoré :
 *   - `fastify.tunnelRegistry` : `TunnelRegistry` (voir `session/registry.ts`).
 *
 * Le plugin `@fastify/websocket` doit être enregistré AVANT les routes
 * qui utilisent `{ websocket: true }` — d'où l'ordre de nommage `05-`
 * (après auth `03-` et session `04-`).
 */

import fastifyWebsocket from "@fastify/websocket";
import fp from "fastify-plugin";
import {
	createTunnelRegistry,
	type TunnelRegistry
} from "../domains/tunnels/session/registry";

declare module "fastify" {
	interface FastifyInstance {
		tunnelRegistry: TunnelRegistry;
	}
}

export default fp(
	async (fastify) => {
		await fastify.register(fastifyWebsocket, {
			options: {
				// Rejeter les frames > 4MB — protège contre les payloads
				// abusifs (le protocole SQLNest gère des resultsets < 4MB
				// typiquement ; frames plus gros = attaque ou bug côté CLI).
				maxPayload: 4 * 1024 * 1024
			}
		});

		fastify.decorate("tunnelRegistry", createTunnelRegistry());
	},
	{
		name: "05-tunnels",
		dependencies: ["04-session"]
	}
);
