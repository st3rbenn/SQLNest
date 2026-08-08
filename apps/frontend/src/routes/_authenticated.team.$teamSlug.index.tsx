/**
 * Route `/team/:teamSlug` — gallery de la team courante (C.21.5).
 * Réutilise `GalleryPage` qui lit le slug via `useCurrentTeamSlug`.
 */

import { createFileRoute } from "@tanstack/react-router";
import { GalleryPage } from "../features/gallery/GalleryPage";

export const Route = createFileRoute("/_authenticated/team/$teamSlug/")({
	component: GalleryPage
});
