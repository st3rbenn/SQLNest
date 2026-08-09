/**
 * Route `/team/:teamSlug/canvas` — liste de tous les canvas de la team,
 * avec tri + toggle grid/list. Rend `GalleryPage view="canvas"`.
 *
 * Le detail canvas individuel vit à `/team/:teamSlug/canvas/:connId`
 * (voir `_authenticated.team.$teamSlug.canvas.$connId.index.tsx`) —
 * ces 2 routes coexistent car ce fichier est l'INDEX du segment
 * `canvas` alors que l'autre est un enfant paramétré.
 */

import { createFileRoute } from "@tanstack/react-router";
import { GalleryPage } from "../features/gallery/GalleryPage";

export const Route = createFileRoute(
	"/_authenticated/team/$teamSlug/canvas/"
)({
	component: () => <GalleryPage view="canvas" />
});
