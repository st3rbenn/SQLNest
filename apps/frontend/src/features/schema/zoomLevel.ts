/**
 * Niveau de détail (LOD) selon le zoom courant. À faible zoom la carte se
 * réduit — à très faible zoom seule la pastille reste. Le rendu de la table
 * lit ce niveau via `useStore((s) => levelForZoom(s.transform[2]))` :
 * Zustand ne re-render la node que quand le NIVEAU change (pas à chaque
 * pixel de zoom).
 */
export type ZoomLevel = "full" | "compact" | "pill" | "dot";

/**
 * Seuils exportés pour tests et éventuelle configurabilité future.
 * FULL_MIN volontairement bas (0.3) — les cartes restent GARNIES (fields
 * visibles) sur une large plage de zoom, l'utilisateur peut dézoomer un peu
 * pour prendre du recul sans que la carte bascule en `compact` (colored card
 * silencieuse). Bascule au dezoom : full → compact vers 0.3, compact → pill
 * vers 0.2, pill → dot vers 0.1.
 */
export const ZOOM_LEVELS = {
	FULL_MIN: 0.3,
	COMPACT_MIN: 0.2,
	PILL_MIN: 0.1
} as const;

export function levelForZoom(zoom: number): ZoomLevel {
	if (zoom >= ZOOM_LEVELS.FULL_MIN) return "full";
	if (zoom >= ZOOM_LEVELS.COMPACT_MIN) return "compact";
	if (zoom >= ZOOM_LEVELS.PILL_MIN) return "pill";
	return "dot";
}
