/**
 * Route legacy `/canvas/:connId/query` — redirect vers
 * `/team/:defaultSlug/canvas/:connId/query`. Conservée pour les
 * bookmarks historiques.
 */

import { queryOptions } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { fetchDefaultTeam } from "../features/teams/teamsClient";

const defaultTeamQueryOptions = queryOptions({
	queryKey: ["team", "me", "default"],
	queryFn: fetchDefaultTeam,
	staleTime: 60_000
});

// Le search param `source` (+ `autorun`) est préservé au redirect via
// `search: (prev) => prev` — un deep-link SNQL depuis un editor externe
// continue de fonctionner.
export const Route = createFileRoute("/_authenticated/canvas/$connId/query")({
	beforeLoad: async ({ context, params, search }) => {
		const team = await context.queryClient.ensureQueryData(
			defaultTeamQueryOptions
		);
		throw redirect({
			to: "/team/$teamSlug/canvas/$connId/query",
			params: { teamSlug: team.slug, connId: params.connId },
			search: search as never
		});
	}
});
