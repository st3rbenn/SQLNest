/**
 * Landing des pages authentifiées — redirect vers la team perso par
 * défaut (C.21.5). Toute l'app tourne désormais sous `/team/:slug/*` ;
 * cette route est un pur router (fetch team perso via
 * `/api/teams/me/default`, redirect immédiat).
 *
 * La route legacy `/` continue d'exister pour :
 *   - permettre aux bookmarks historiques de rediriger proprement,
 *   - accueillir le fallback lazy si le hook Better Auth `user.create.after`
 *     a raté (la route `/api/teams/me/default` crée la team à la volée).
 */

import { queryOptions } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { fetchDefaultTeam } from "../features/teams/teamsClient";

const defaultTeamQueryOptions = queryOptions({
	queryKey: ["team", "me", "default"],
	queryFn: fetchDefaultTeam,
	staleTime: 60_000
});

export const Route = createFileRoute("/_authenticated/")({
	beforeLoad: async ({ context }) => {
		const team = await context.queryClient.ensureQueryData(
			defaultTeamQueryOptions
		);
		throw redirect({
			to: "/team/$teamSlug",
			params: { teamSlug: team.slug }
		});
	}
});
