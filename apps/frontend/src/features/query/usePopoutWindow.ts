/**
 * Détache la console SNQL dans une fenêtre browser dédiée — pattern
 * "docked → undocked" façon DevTools / Figma / Notion. La cible nommée
 * `sqlnest-console-<connId>` re-focus une fenêtre déjà ouverte au lieu
 * d'en dupliquer.
 *
 * L'URL cible reste la même route (`/team/<slug>/canvas/<connId>/query`)
 * avec `?popout=1` en flag pour que le shell console cache le back
 * button et affiche `Fermer` (window.close) à la place.
 *
 * Contrainte popup blocker : `window.open()` doit être appelé dans un
 * handler synchrone d'événement user (onClick). Aucun setTimeout /
 * await ne doit précéder l'appel — le browser tag alors le trigger
 * comme "user activation" et laisse passer.
 */

import { useSearch } from "@tanstack/react-router";

export const POPOUT_WINDOW_FEATURES =
	"popup=yes,width=1600,height=1000,menubar=no,toolbar=no,location=no";

export function openConsoleInPopout(
	teamSlug: string,
	connId: string
): Window | null {
	const url = `/team/${encodeURIComponent(teamSlug)}/canvas/${encodeURIComponent(connId)}/query?popout=1`;
	const win = window.open(
		url,
		`sqlnest-console-${connId}`,
		POPOUT_WINDOW_FEATURES
	);
	win?.focus();
	return win;
}

/**
 * Lit `?popout=1` depuis les search params TanStack Router de la route
 * `/team/$teamSlug/canvas/$connId/query`. Doit être appelé DANS un
 * composant rendu sous cette route (sinon useSearch throw).
 */
export function useIsPopout(): boolean {
	const search = useSearch({
		from: "/_authenticated/team/$teamSlug/canvas/$connId/query"
	}) as { popout?: 1 };
	return search.popout === 1;
}
