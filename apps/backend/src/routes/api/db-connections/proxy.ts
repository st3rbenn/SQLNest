/**
 * Routes proxifiées `/api/db-connections/:id/{schema,query}`.
 *
 * ─── Contrat ─────────────────────────────────────────────────────────
 * L'user connecté demande une opération applicative (introspection ou
 * exécution SNQL) sur une DB à laquelle un CLI est actuellement branché
 * via le tunnel. Le backend :
 *   1. Vérifie que `connection_id` appartient bien à l'user (isolation
 *      stricte via WHERE user_id).
 *   2. Cherche le tunnel actif pour cette connection dans le registry.
 *   3. Envoie une frame `req` signée (via `backendProxy.sendReq`) au CLI,
 *      attend la `res` (timeout 30s par défaut), retourne le résultat.
 *
 * ─── Mapping des erreurs ─────────────────────────────────────────────
 *   - Connection inconnue ou pas au user   → 404
 *   - Pas de tunnel actif                  → 503 "CLI offline"
 *   - Timeout côté CLI                     → 504
 *   - CLI a renvoyé une erreur applicative → 502 "CLI error: …"
 *   - Reste (bug, exception non typée)     → 500
 */

import { schema as dbSchema } from "@sqlnest/db";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
	assertAuthenticated,
	requireUser
} from "../../../domains/auth/require";
import {
	ConnectionIdParams,
	ProxyErrorResponse,
	ProxyQueryBody
} from "../../../domains/db-connections/proxy-schema";
import {
	NoTunnelError,
	TunnelCliError,
	TunnelTimeoutError
} from "../../../domains/tunnels/backend-proxy";

/**
 * Vérifie que la connection appartient à l'user + retourne le tunnelId
 * actif. Throw des erreurs typées pour un mapping HTTP propre.
 */
async function resolveActiveTunnel(
	fastify: FastifyInstance,
	userId: string,
	connectionId: string
): Promise<{ tunnelId: string }> {
	const rows = await fastify.db
		.select({ id: dbSchema.dbConnection.id })
		.from(dbSchema.dbConnection)
		.where(
			and(
				eq(dbSchema.dbConnection.id, connectionId),
				eq(dbSchema.dbConnection.userId, userId)
			)
		)
		.limit(1);
	if (rows.length === 0) {
		throw new ConnectionNotFoundError();
	}
	const slot = fastify.tunnelRegistry.findByConnection(userId, connectionId);
	if (!slot || !slot.cli) {
		throw new NoTunnelError(connectionId);
	}
	return { tunnelId: slot.tunnelId };
}

class ConnectionNotFoundError extends Error {
	constructor() {
		super("connection introuvable ou n'appartient pas à cet user");
		this.name = "ConnectionNotFoundError";
	}
}

export default function dbConnectionsProxyRoute(fastify: FastifyInstance) {
	const instance = fastify.withTypeProvider<ZodTypeProvider>();

	// ─── GET /:id/schema — introspection ──────────────────────────────
	instance.get(
		"/:id/schema",
		{
			preHandler: [requireUser],
			schema: {
				params: ConnectionIdParams,
				response: {
					404: ProxyErrorResponse,
					500: ProxyErrorResponse,
					502: ProxyErrorResponse,
					503: ProxyErrorResponse,
					504: ProxyErrorResponse
				}
			}
		},
		async (request, reply) => {
			assertAuthenticated(request);
			try {
				const { tunnelId } = await resolveActiveTunnel(
					fastify,
					request.user.id,
					request.params.id
				);
				const result = await fastify.backendProxy.sendReq(tunnelId, {
					op: "introspect"
				});
				return result;
			} catch (err) {
				return mapErrorToReply(err, reply, request);
			}
		}
	);

	// ─── POST /:id/query — exécution SNQL ─────────────────────────────
	instance.post(
		"/:id/query",
		{
			preHandler: [requireUser],
			schema: {
				params: ConnectionIdParams,
				body: ProxyQueryBody,
				response: {
					400: ProxyErrorResponse,
					404: ProxyErrorResponse,
					500: ProxyErrorResponse,
					502: ProxyErrorResponse,
					503: ProxyErrorResponse,
					504: ProxyErrorResponse
				}
			}
		},
		async (request, reply) => {
			assertAuthenticated(request);
			try {
				const { tunnelId } = await resolveActiveTunnel(
					fastify,
					request.user.id,
					request.params.id
				);
				const result = await fastify.backendProxy.sendReq(tunnelId, {
					op: "runSnql",
					src: request.body.source
				});
				return result;
			} catch (err) {
				return mapErrorToReply(err, reply, request);
			}
		}
	);
}

function mapErrorToReply(
	err: unknown,
	reply: import("fastify").FastifyReply,
	request: import("fastify").FastifyRequest
): unknown {
	if (err instanceof ConnectionNotFoundError) {
		return reply.code(404).send({ message: err.message });
	}
	if (err instanceof NoTunnelError) {
		return reply.code(503).send({
			message:
				"Aucun CLI n'est actuellement connecté à cette connection. Lance " +
				"`sqlnest connect` sur ta machine pour démarrer le tunnel."
		});
	}
	if (err instanceof TunnelTimeoutError) {
		return reply.code(504).send({
			message: "Le CLI n'a pas répondu dans les temps (30s). Réessaie."
		});
	}
	if (err instanceof TunnelCliError) {
		return reply
			.code(502)
			.send({ message: `Erreur côté CLI: ${err.cliMessage}` });
	}
	request.log.error({ err }, "db-connections proxy failed");
	return reply.code(500).send({ message: "Erreur interne" });
}
