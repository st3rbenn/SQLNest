/**
 * `requireTeamAccess` — preHandler Fastify qui garantit :
 *   1. l'user est authentifié (via `requireUser` in-line, court-circuite
 *      la chaîne avec 401 sinon) ;
 *   2. le `:slug` de l'URL est syntaxiquement valide (regex 6 hex) ;
 *   3. il existe une team avec ce slug ET dont l'owner === user.id.
 *
 * En cas d'échec sur (2) ou (3), on répond **404** — pas 403 — pour ne
 * pas fuiter l'existence d'une team d'un autre user. Même erreur que
 * "slug inexistant" côté client.
 *
 * En cas de succès, la team est décorée sur la request via
 * `request.team` (le handler downstream lit `request.team.id` sans
 * refaire de lookup).
 */

import type { FastifyReply, FastifyRequest } from "fastify";
import { assertAuthenticated } from "../auth/require";
import type { DbOrTx } from "./db";
import { getTeamForOwner, type TeamSummary } from "./get";
import { TEAM_SLUG_REGEX } from "./slug";

declare module "fastify" {
	interface FastifyRequest {
		/** Team courante — décorée par le preHandler `requireTeamAccess`.
		 *  `null` en dehors des routes team-scoped. Le handler downstream
		 *  peut faire `assertTeamAccess(request)` pour narrower le type. */
		team: TeamSummary | null;
	}
}

/** Assertion function TS — utilisable dans les handlers pour narrower
 *  le type de `request.team` de `TeamSummary | null` à `TeamSummary`.
 *  Miroir de `assertAuthenticated`. */
export function assertTeamAccess(
	request: FastifyRequest
): asserts request is FastifyRequest & {
	user: NonNullable<FastifyRequest["user"]>;
	team: TeamSummary;
} {
	assertAuthenticated(request);
	if (request.team == null) {
		const err = new Error("Team non résolue") as Error & { statusCode: number };
		err.statusCode = 500;
		throw err;
	}
}

/** Factory : renvoie un preHandler paramétrable — utile si on veut un
 *  jour changer la source de la DB. Aujourd'hui `fastify.db`. */
export async function requireTeamAccess(
	request: FastifyRequest,
	reply: FastifyReply
): Promise<void> {
	// 1) auth
	if (request.user == null) {
		reply.code(401).send({ message: "Non authentifié" });
		return;
	}

	// 2) slug format
	const params = request.params as { slug?: unknown };
	const slug = typeof params.slug === "string" ? params.slug : "";
	if (!TEAM_SLUG_REGEX.test(slug)) {
		reply.code(404).send({ message: "Team introuvable" });
		return;
	}

	// 3) ownership
	const db = request.server.db as unknown as DbOrTx;
	const team = await getTeamForOwner(db, slug, request.user.id);
	if (!team) {
		reply.code(404).send({ message: "Team introuvable" });
		return;
	}

	request.team = team;
}
