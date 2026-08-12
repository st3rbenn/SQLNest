/**
 * Routes team-scoped proxifiées vers le CLI (C.21.3).
 *
 *   GET  /api/teams/:slug/db-connections/:id/schema
 *   POST /api/teams/:slug/db-connections/:id/query
 *
 * Miroir de `routes/api/db-connections/proxy.ts` — même logique, mais
 * l'autorisation passe par `team_id` (via `requireTeamAccess` +
 * `assertConnectionInTeam`) plutôt que par `user_id` direct.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import z from "zod/v4";
import { assertConnectionInTeam } from "../../../domains/db-connections/get-in-team";
import {
	PgErrorInfoSchema,
	ProxyErrorResponse,
	ProxyQueryBody,
	ProxyQueryResponse
} from "../../../domains/db-connections/proxy-schema";
import {
	assertTeamAccess,
	requireTeamAccess
} from "../../../domains/teams/require-team-access";
import { TeamSlugParams } from "../../../domains/teams/schema";
import {
	NoTunnelError,
	TunnelCliError,
	TunnelTimeoutError
} from "../../../domains/tunnels/backend-proxy";

const SlugAndConnectionParams = TeamSlugParams.extend({
	id: z.uuid()
});
z.globalRegistry.add(SlugAndConnectionParams, {
	id: "TeamProxySlugAndConnectionIdParams"
});
type SlugAndConnectionParamsT = z.infer<typeof SlugAndConnectionParams>;

class ConnectionNotInTeamError extends Error {
	constructor() {
		super("connection introuvable ou n'appartient pas à cette team");
		this.name = "ConnectionNotInTeamError";
	}
}

async function resolveActiveTunnelInTeam(
	fastify: FastifyInstance,
	userId: string,
	teamId: string,
	connectionId: string
): Promise<{ tunnelId: string }> {
	const ok = await assertConnectionInTeam(fastify.db, teamId, connectionId);
	if (!ok) throw new ConnectionNotInTeamError();
	// Le registry indexe encore par (userId, connectionId) — en V1 (owner
	// unique de la team) c'est équivalent à (teamId, connectionId). En V2
	// il faudra scoper le registry par teamId aussi.
	const slot = fastify.tunnelRegistry.findByConnection(userId, connectionId);
	if (!slot || !slot.cli) {
		throw new NoTunnelError(connectionId);
	}
	return { tunnelId: slot.tunnelId };
}

function mapErrorToReply(
	err: unknown,
	reply: FastifyReply,
	request: FastifyRequest
): unknown {
	if (err instanceof ConnectionNotInTeamError) {
		return reply.code(404).send({ message: err.message });
	}
	if (err instanceof NoTunnelError) {
		return reply.code(503).send({
			message:
				"Aucun tunnel disponible. Lancer `sqlnest connect` dans un terminal pour démarrer un tunnel."
		});
	}
	if (err instanceof TunnelTimeoutError) {
		return reply.code(504).send({
			message: "Le CLI n'a pas répondu dans les temps (30s). Réessaie."
		});
	}
	if (err instanceof TunnelCliError) {
		// Erreur `pg` structurée (Phase 3a) — route en 400 (payload user-recoverable :
		// SQL invalide, contrainte violée, type inconnu…). Le frontend a besoin de
		// `pgError` pour rendre son ErrorBlock (chip `$N`, jump-to-span). Validation
		// Zod stricte à la frontière — un pgError malformé est droppé silencieusement
		// pour ne jamais empêcher le message string d'atteindre l'utilisateur.
		if (err.pgError !== undefined) {
			const parsed = PgErrorInfoSchema.safeParse(err.pgError);
			return reply.code(400).send({
				message: err.cliMessage,
				...(parsed.success ? { pgError: parsed.data } : {})
			});
		}
		return reply
			.code(502)
			.send({ message: `Erreur côté CLI: ${err.cliMessage}` });
	}
	request.log.error({ err }, "teams db-connections proxy failed");
	return reply.code(500).send({ message: "Erreur interne" });
}

export default function teamsDbConnectionsProxyRoute(fastify: FastifyInstance) {
	const instance = fastify.withTypeProvider<ZodTypeProvider>();

	// ─── GET /:slug/db-connections/:id/schema ────────────────────────
	instance.get(
		"/:slug/db-connections/:id/schema",
		{
			preHandler: [requireTeamAccess],
			schema: {
				params: SlugAndConnectionParams,
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
			assertTeamAccess(request);
			try {
				const params = request.params as SlugAndConnectionParamsT;
				const { tunnelId } = await resolveActiveTunnelInTeam(
					fastify,
					request.user.id,
					request.team.id,
					params.id
				);
				return await fastify.backendProxy.sendReq(tunnelId, {
					op: "introspect"
				});
			} catch (err) {
				return mapErrorToReply(err, reply, request);
			}
		}
	);

	// ─── POST /:slug/db-connections/:id/query ────────────────────────
	instance.post(
		"/:slug/db-connections/:id/query",
		{
			preHandler: [requireTeamAccess],
			schema: {
				params: SlugAndConnectionParams,
				body: ProxyQueryBody,
				response: {
					200: ProxyQueryResponse,
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
			assertTeamAccess(request);
			try {
				const params = request.params as SlugAndConnectionParamsT;
				const { tunnelId } = await resolveActiveTunnelInTeam(
					fastify,
					request.user.id,
					request.team.id,
					params.id
				);
				return await fastify.backendProxy.sendReq(tunnelId, {
					op: "runSnql",
					src: request.body.source
				});
			} catch (err) {
				return mapErrorToReply(err, reply, request);
			}
		}
	);
}
