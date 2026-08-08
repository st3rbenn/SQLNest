/**
 * Routes `/api/teams/*` — méta-info des teams de l'user (C.21.3).
 *
 * ─── Endpoints (tous protégés par requireUser) ────────────────────────
 *   GET  /api/teams/me                      → { teams: [...] }
 *   GET  /api/teams/me/default              → team perso (crée lazy)
 *   GET  /api/teams/:slug                   → { id, slug, name, createdAt }
 *
 * Les routes team-scoped (db-connections, canvas-state, tunnels) vivent
 * dans les fichiers sœurs — chargées automatiquement par
 * `@fastify/autoload` avec le même prefix `/api/teams`. */

import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
	assertAuthenticated,
	requireUser
} from "../../../domains/auth/require";
import {
	createPersonalTeam,
	defaultTeamNameForUser
} from "../../../domains/teams/create";
import {
	getDefaultTeamOfUser,
	listTeamsOfUser
} from "../../../domains/teams/get";
import { requireTeamAccess } from "../../../domains/teams/require-team-access";
import {
	ListTeamsResponse,
	TeamSlugParams,
	TeamSummaryResponse,
	TeamsErrorResponse
} from "../../../domains/teams/schema";

export default function teamsRoute(fastify: FastifyInstance) {
	const instance = fastify.withTypeProvider<ZodTypeProvider>();

	// ─── GET /me ─────────────────────────────────────────────────────
	instance.get(
		"/me",
		{
			preHandler: [requireUser],
			schema: {
				response: {
					200: ListTeamsResponse,
					500: TeamsErrorResponse
				}
			}
		},
		async (request, reply) => {
			assertAuthenticated(request);
			try {
				const teams = await listTeamsOfUser(fastify.db, request.user.id);
				return {
					teams: teams.map((t) => ({
						id: t.id,
						slug: t.slug,
						name: t.name,
						createdAt: t.createdAt.toISOString()
					}))
				};
			} catch (err) {
				request.log.error({ err }, "GET /api/teams/me failed");
				return reply.code(500).send({ message: "Erreur interne" });
			}
		}
	);

	// ─── GET /me/default ─────────────────────────────────────────────
	// Fallback lazy : si le hook Better Auth `user.create.after` a raté
	// (rare : erreur DB transitoire), on crée la team perso ici — garantit
	// qu'aucune signup ne peut se retrouver sans team.
	instance.get(
		"/me/default",
		{
			preHandler: [requireUser],
			schema: {
				response: {
					200: TeamSummaryResponse,
					500: TeamsErrorResponse
				}
			}
		},
		async (request, reply) => {
			assertAuthenticated(request);
			try {
				const existing = await getDefaultTeamOfUser(
					fastify.db,
					request.user.id
				);
				if (existing) {
					return {
						id: existing.id,
						slug: existing.slug,
						name: existing.name,
						createdAt: existing.createdAt.toISOString()
					};
				}
				// Fallback lazy
				const created = await createPersonalTeam(
					fastify.db,
					request.user.id,
					defaultTeamNameForUser(request.user.name)
				);
				return {
					id: created.teamId,
					slug: created.slug,
					name: created.name,
					createdAt: new Date().toISOString()
				};
			} catch (err) {
				request.log.error({ err }, "GET /api/teams/me/default failed");
				return reply.code(500).send({ message: "Erreur interne" });
			}
		}
	);

	// ─── GET /:slug ──────────────────────────────────────────────────
	instance.get(
		"/:slug",
		{
			preHandler: [requireTeamAccess],
			schema: {
				params: TeamSlugParams,
				response: {
					200: TeamSummaryResponse,
					404: TeamsErrorResponse
				}
			}
		},
		async (request) => {
			// requireTeamAccess a peuplé request.team ou short-circuité en 404.
			const t = request.team;
			if (!t) {
				// Défensif — préconditions violées.
				return {
					id: "",
					slug: "",
					name: "",
					createdAt: new Date(0).toISOString()
				};
			}
			return {
				id: t.id,
				slug: t.slug,
				name: t.name,
				createdAt: t.createdAt.toISOString()
			};
		}
	);
}
