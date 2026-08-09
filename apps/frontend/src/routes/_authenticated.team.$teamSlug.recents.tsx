/**
 * Route `/team/:teamSlug/recents` — vue « Recents » de la gallery.
 *
 * En V1 affiche la même liste que « Canvas » (canvas de la team
 * courante) — seul le titre, le tri et l'item actif dans la sidebar
 * changent (Recents = bucket MRU localStorage). En V2 cette vue
 * agrégera les canvas récemment ouverts tous workspaces confondus
 * (own team, external teams, communautaire).
 */

import { createFileRoute } from "@tanstack/react-router";
import { GalleryPage } from "../features/gallery/GalleryPage";

export const Route = createFileRoute(
	"/_authenticated/team/$teamSlug/recents"
)({
	component: () => <GalleryPage view="recents" />
});
