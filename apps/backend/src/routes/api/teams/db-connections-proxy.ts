/**
 * Routes team-scoped proxifiées vers le CLI :
 *
 *   GET  /api/teams/:slug/db-connections/:id/schema
 *   POST /api/teams/:slug/db-connections/:id/query
 *   GET  /api/teams/:slug/db-connections/:id/project-status
 *   POST /api/teams/:slug/db-connections/:id/schema-change
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
	ProjectStatusResponse,
	ProxyErrorResponse,
	ProxyQueryBody,
	ProxyQueryResponse,
	SchemaChangeBody,
	SchemaChangeResponse
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

/** Outil de l'ORM, base shadow et contrôles : plusieurs commandes à la suite. */
const SCHEMA_CHANGE_TIMEOUT_MS = 180_000;

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
			message: `Le CLI n'a pas répondu dans les temps (${Math.round(err.ms / 1000)}s). Réessaie.`
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

	// ─── GET /:slug/db-connections/:id/project-status ────────────────
	// Projet relié côté CLI (ADR-037 D2) : relié ou non, ORM, `apply`,
	// table d'historique. Le chemin reste sur la machine de l'utilisateur.
	instance.get(
		"/:slug/db-connections/:id/project-status",
		{
			preHandler: [requireTeamAccess],
			schema: {
				params: SlugAndConnectionParams,
				response: {
					200: ProjectStatusResponse,
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
					op: "projectStatus"
				});
			} catch (err) {
				return mapErrorToReply(err, reply, request);
			}
		}
	);

	// ─── POST /:slug/db-connections/:id/schema-change ────────────────
	// Changement de schéma dans le projet relié côté CLI (ADR-037 D3) :
	// migration écrite, modèle patché et validé, base mise à jour, contrôles.
	// Un échec (validation, application) remonte en 422 avec le message de
	// l'outil ; les fichiers du projet sont alors remis en l'état.
	instance.post(
		"/:slug/db-connections/:id/schema-change",
		{
			preHandler: [requireTeamAccess],
			schema: {
				params: SlugAndConnectionParams,
				body: SchemaChangeBody,
				response: {
					200: SchemaChangeResponse,
					404: ProxyErrorResponse,
					422: ProxyErrorResponse,
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
				const { source, names } = request.body;
				return await fastify.backendProxy.sendReq(
					tunnelId,
					{
						op: "applySchemaChange",
						src: source,
						...(names !== undefined ? { names } : {})
					},
					{ timeoutMs: SCHEMA_CHANGE_TIMEOUT_MS }
				);
			} catch (err) {
				if (err instanceof TunnelCliError && err.pgError === undefined) {
					return reply.code(422).send({ message: err.cliMessage });
				}
				return mapErrorToReply(err, reply, request);
			}
		}
	);
}
