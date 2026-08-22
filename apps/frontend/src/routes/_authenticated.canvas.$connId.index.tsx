/**
 * Route legacy `/canvas/:connId` — redirect vers
 * `/team/:defaultSlug/canvas/:connId`. Conservée pour les bookmarks
 * historiques. La vraie route est team-scoped.
 */

import { queryOptions } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { fetchDefaultTeam } from "../features/teams/teamsClient";

const defaultTeamQueryOptions = queryOptions({
	queryKey: ["team", "me", "default"],
	queryFn: fetchDefaultTeam,
	staleTime: 60_000
});

export const Route = createFileRoute("/_authenticated/canvas/$connId/")({
	beforeLoad: async ({ context, params }) => {
		const team = await context.queryClient.ensureQueryData(
			defaultTeamQueryOptions
		);
		throw redirect({
			to: "/team/$teamSlug/canvas/$connId",
			params: { teamSlug: team.slug, connId: params.connId }
		});
	}
});
