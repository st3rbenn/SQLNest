/**
 * Layout des routes team-scoped `/team/:teamSlug/*`.
 *
 * `beforeLoad` :
 *   1. Fetch `/api/teams/:slug` via le queryClient — 404 si l'user
 *      n'est pas owner OU si le slug n'existe pas (pas de distinction).
 *   2. Sur 404 → redirect vers `/` (qui redirigera vers la team perso
 *      via `/api/teams/me/default`).
 *   3. Sinon → dépose `{ team }` dans le context du router, disponible
 *      pour tous les enfants via `useCurrentTeam()`.
 */

import { queryOptions } from "@tanstack/react-query";
import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { fetchTeamBySlug } from "../features/teams/teamsClient";

const teamQueryOptions = (slug: string) =>
	queryOptions({
		queryKey: ["team", slug],
		queryFn: () => fetchTeamBySlug(slug),
		staleTime: 60_000
	});

export const Route = createFileRoute("/_authenticated/team/$teamSlug")({
	beforeLoad: async ({ context, params }) => {
		try {
			const team = await context.queryClient.ensureQueryData(
				teamQueryOptions(params.teamSlug)
			);
			return { team };
		} catch {
			throw redirect({ to: "/" });
		}
	},
	component: TeamLayout
});

function TeamLayout() {
	return <Outlet />;
}
