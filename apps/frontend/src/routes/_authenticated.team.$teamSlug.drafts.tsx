/**
 * Route legacy `/team/:teamSlug/drafts` — renommée en `/canvas`.
 * On garde ici un redirect pour ne pas casser les bookmarks / URLs
 * partagées historiques.
 */

import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/team/$teamSlug/drafts")({
	beforeLoad: ({ params }) => {
		throw redirect({
			to: "/team/$teamSlug/canvas",
			params: { teamSlug: params.teamSlug }
		});
	}
});
