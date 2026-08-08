/**
 * Route legacy `/pair` — redirect vers `/team/:defaultSlug/pair`.
 * Conservée pour les bookmarks et les URLs affichées par le CLI sans
 * team-slug ; la vraie route vit sous `/team/:teamSlug/pair`.
 */

import { queryOptions } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { fetchDefaultTeam } from "../features/teams/teamsClient";

const defaultTeamQueryOptions = queryOptions({
	queryKey: ["team", "me", "default"],
	queryFn: fetchDefaultTeam,
	staleTime: 60_000
});

export const Route = createFileRoute("/_authenticated/pair")({
	beforeLoad: async ({ context }) => {
		const team = await context.queryClient.ensureQueryData(
			defaultTeamQueryOptions
		);
		throw redirect({
			to: "/team/$teamSlug/pair",
			params: { teamSlug: team.slug }
		});
	}
});
