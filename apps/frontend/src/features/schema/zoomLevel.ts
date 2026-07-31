/**
 * Niveau de détail (LOD) selon le zoom courant. À faible zoom la carte se
 * réduit — à très faible zoom seule la pastille reste. Le rendu de la table
 * lit ce niveau via `useStore((s) => levelForZoom(s.transform[2]))` :
 * Zustand ne re-render la node que quand le NIVEAU change (pas à chaque
 * pixel de zoom).
 */
export type ZoomLevel = "full" | "compact" | "pill" | "dot";

/** Seuils exportés pour tests et éventuelle configurabilité future. */
export const ZOOM_LEVELS = {
	FULL_MIN: 0.5,
	COMPACT_MIN: 0.2,
	PILL_MIN: 0.1
} as const;

export function levelForZoom(zoom: number): ZoomLevel {
	if (zoom >= ZOOM_LEVELS.FULL_MIN) return "full";
	if (zoom >= ZOOM_LEVELS.COMPACT_MIN) return "compact";
	if (zoom >= ZOOM_LEVELS.PILL_MIN) return "pill";
	return "dot";
}
