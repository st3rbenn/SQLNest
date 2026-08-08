/**
 * Route legacy `/connect` (C.21.7) — redirect vers `/team/:defaultSlug/connect`.
 * Conservée pour les bookmarks existants ; la vraie route vit sous
 * `/team/:teamSlug/connect`.
 */

import { queryOptions } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { fetchDefaultTeam } from "../features/teams/teamsClient";

const defaultTeamQueryOptions = queryOptions({
	queryKey: ["team", "me", "default"],
	queryFn: fetchDefaultTeam,
	staleTime: 60_000
});

export const Route = createFileRoute("/_authenticated/connect")({
	beforeLoad: async ({ context }) => {
		const team = await context.queryClient.ensureQueryData(
			defaultTeamQueryOptions
		);
		throw redirect({
			to: "/team/$teamSlug/connect",
			params: { teamSlug: team.slug }
		});
	}
});
