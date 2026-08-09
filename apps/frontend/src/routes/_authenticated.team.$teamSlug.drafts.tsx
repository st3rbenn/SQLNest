/**
 * Route `/team/:teamSlug/drafts` — liste triée alphabétiquement des
 * canvas de la team. Séparée de `/team/:teamSlug` (qui redirige vers
 * `/recents` — voir `.$teamSlug.index.tsx`) pour que la nav sidebar
 * "Drafts" ait une URL propre à pointer.
 */

import { createFileRoute } from "@tanstack/react-router";
import { GalleryPage } from "../features/gallery/GalleryPage";

export const Route = createFileRoute("/_authenticated/team/$teamSlug/drafts")({
	component: () => <GalleryPage view="drafts" />
});
