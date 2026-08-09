/**
 * Route `/team/:teamSlug/canvas/:connId/query` — console SNQL fullscreen
 * (design 2a). Thin wrapper qui rend `<ConsolePage />` avec les params
 * de la route.
 *
 * Search params supportés :
 *   ?source=<encoded>  — pré-remplit le tab actif s'il est vide
 *   ?autorun=1         — exécute automatiquement au mount (one-shot)
 *   ?popout=1          — indique que la fenêtre est un pop-out détaché
 *                        (cache back button, montre Fermer)
 */

import { createFileRoute } from "@tanstack/react-router";
import { ConsolePage } from "../features/query/ConsolePage";

interface QuerySearch {
	source?: string;
	autorun?: 1;
	popout?: 1;
}

function validateSearch(raw: Record<string, unknown>): QuerySearch {
	const out: QuerySearch = {};
	if (typeof raw.source === "string" && raw.source.length > 0) {
		out.source = raw.source;
	}
	if (raw.autorun === 1 || raw.autorun === "1") {
		out.autorun = 1;
	}
	if (raw.popout === 1 || raw.popout === "1") {
		out.popout = 1;
	}
	return out;
}

export const Route = createFileRoute(
	"/_authenticated/team/$teamSlug/canvas/$connId/query"
)({
	validateSearch,
	component: TeamQueryPage
});

function TeamQueryPage(): React.ReactNode {
	const { teamSlug, connId } = Route.useParams();
	const search = Route.useSearch();
	return (
		<ConsolePage
			teamSlug={teamSlug}
			connId={connId}
			initialSource={search.source}
			initialAutorun={search.autorun === 1}
		/>
	);
}
