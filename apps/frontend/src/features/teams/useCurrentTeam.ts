/**
 * Hook + type pour la team courante (C.21.5).
 *
 * Consommé par les hooks team-aware (useDbConnections, useSchema,
 * useRunQuery, useCanvasSync, previewSnapshotClient). En dehors des
 * routes team-scoped, `useCurrentTeamSlug()` retourne `null` — les
 * hooks fallback alors sur les URLs legacy (`/api/db-connections/*`)
 * jusqu'à C.21.7 où le fallback disparaît.
 *
 * ─── Tolérant hors Router ────────────────────────────────────────────
 * Les tests unitaires qui mount un composant sans `RouterProvider`
 * (`ConnectPage.test.tsx`, `useCanvasSync.test.ts`) crasheraient sur
 * `useMatches()` sinon. On try/catch et fallback à `null`.
 */

import { useMatches } from "@tanstack/react-router";

export interface TeamContext {
	readonly id: string;
	readonly slug: string;
	readonly name: string;
}

/** Renvoie la team courante décorée par le layout `_authenticated.team.$teamSlug`
 *  ou `null` en dehors des routes team-scoped. Lit le context TanStack Router
 *  posé par le loader. */
export function useCurrentTeam(): TeamContext | null {
	let matches: ReturnType<typeof useMatches>;
	try {
		matches = useMatches();
	} catch {
		// Hors RouterProvider (tests) — pas de team.
		return null;
	}
	// Le contexte du loader s'accumule ; on prend le plus profond qui a `team`.
	for (let i = matches.length - 1; i >= 0; i--) {
		const m = matches[i];
		if (!m) continue;
		const ctx = m.context as { readonly team?: TeamContext } | undefined;
		if (ctx?.team) return ctx.team;
	}
	return null;
}

/** Sucre : renvoie juste le slug (utilisé par les hooks pour construire
 *  les URLs). */
export function useCurrentTeamSlug(): string | null {
	return useCurrentTeam()?.slug ?? null;
}
