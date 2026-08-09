/**
 * Route `/team/:teamSlug` — redirige vers `/recents` (home canonique).
 * Catch les bookmarks / URLs partagées historiques qui pointaient sur
 * `/team/:slug` directement.
 */

import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/team/$teamSlug/")({
	beforeLoad: ({ params }) => {
		throw redirect({
			to: "/team/$teamSlug/recents",
			params: { teamSlug: params.teamSlug }
		});
	}
});
