/**
 * Route legacy `/pair` — redirect vers `/team/:defaultSlug/pair`.
 * Conservée pour les bookmarks et les URLs affichées par le CLI sans
 * team-slug ; la vraie route vit sous `/team/:teamSlug/pair`.
 *
 * P/2 (ADR-022 D7) : le CLI ouvre `/pair?code=XXXX-XXXX` — on doit
 * forwarder le search dans le redirect sinon le code est perdu et
 * l'user tombe sur l'input vide.
 */

import { queryOptions } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { fetchDefaultTeam } from "../features/teams/teamsClient";

const defaultTeamQueryOptions = queryOptions({
	queryKey: ["team", "me", "default"],
	queryFn: fetchDefaultTeam,
	staleTime: 60_000
});

interface PairSearch {
	code: string | null;
}

function validateSearch(raw: Record<string, unknown>): PairSearch {
	if (typeof raw.code === "string" && raw.code.length > 0) {
		return { code: raw.code };
	}
	return { code: null };
}

export const Route = createFileRoute("/_authenticated/pair")({
	validateSearch,
	beforeLoad: async ({ context, search }) => {
		const team = await context.queryClient.ensureQueryData(
			defaultTeamQueryOptions
		);
		throw redirect({
			to: "/team/$teamSlug/pair",
			params: { teamSlug: team.slug },
			search: { code: search.code }
		});
	}
});
