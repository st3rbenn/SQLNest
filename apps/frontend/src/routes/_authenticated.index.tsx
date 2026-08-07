import { createFileRoute } from "@tanstack/react-router";
import { GalleryPage } from "../features/gallery/GalleryPage";

/**
 * Landing des pages authentifiées : gallery des db_connections.
 * Le canvas d'une DB spécifique vit sur `/canvas/$connId` (voir
 * `_authenticated.canvas.$connId.tsx`).
 */
export const Route = createFileRoute("/_authenticated/")({
	component: GalleryPage
});
