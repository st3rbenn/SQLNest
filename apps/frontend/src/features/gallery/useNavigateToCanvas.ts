import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type MouseEvent, useCallback, useState } from "react";
import { fetchCanvasState } from "../schema/canvas/canvasStateClient";
import { fetchSchema } from "../schema/useSchema";
import { useCurrentTeamSlug } from "../teams/useCurrentTeam";

/**
 * Navigation "prefetch-then-navigate" vers un canvas.
 *
 * ─── Problème ─────────────────────────────────────────────────────────
 * Un `Link` naïf navigate direct → l'user voit gallery → écran vide →
 * canvas qui apparaît après ~1s (fetch schema tunnel WSS + layout ELK).
 * Perception : app lente, flash de vide.
 *
 * ─── Solution ─────────────────────────────────────────────────────────
 * Intercept le click, prefetch le schema via TanStack (cache warm), PUIS
 * navigate. Le canvas mount trouve la data en cache → rend instantanément.
 * Pendant le prefetch, `pendingId` est set → l'UI parent (gallery) peut
 * blur + surligner la card cliquée pour signaler "chargement".
 *
 * ─── Comportements natifs préservés ──────────────────────────────────
 * Cmd/Ctrl/Shift + click ou middle-click → le handler laisse le Link
 * natif faire son travail (nouvel onglet). Le prefetch est skippé (le
 * nouvel onglet aura son propre fetch au mount).
 */

export interface NavigateToCanvasHandle {
	/** id en cours de préchargement, `null` si idle. */
	readonly pendingId: string | null;
	/**
	 * Handler à brancher sur un `<Link onClick>`. Reçoit l'event pour
	 * détecter les modificateurs (cmd/ctrl/shift/middle). Prefetch puis
	 * navigate ; si prefetch échoue, navigate quand même (le canvas
	 * affichera l'erreur).
	 */
	readonly handleClick: (
		e: MouseEvent<HTMLAnchorElement>,
		connectionId: string
	) => void;
}

export function useNavigateToCanvas(): NavigateToCanvasHandle {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const teamSlug = useCurrentTeamSlug();
	const [pendingId, setPendingId] = useState<string | null>(null);

	const handleClick = useCallback(
		(e: MouseEvent<HTMLAnchorElement>, connectionId: string) => {
			// Modificateurs → nouvel onglet / autre comportement système. On
			// laisse le Link natif faire son job, sans prefetch (le nouvel
			// onglet mountera fresh).
			if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) {
				return;
			}
			e.preventDefault();
			setPendingId(connectionId);
			void (async () => {
				// Prefetch EN PARALLÈLE tout ce dont la page canvas a
				// besoin pour rendre sans état intermédiaire :
				//   - `schema` (introspection tunnel WSS) — SchemaCanvas
				//     ne mount qu'avec ce data.
				//   - `canvas-state` (positions/sizes/frames sauvegardés)
				//     — useCanvasSync hydrate au mount, sans prefetch
				//     l'user voit le layout ELK par défaut puis un saut
				//     vers ses positions.
				// Un échec (503 CLI offline, 404, réseau) ne bloque PAS
				// la navigation — le canvas montrera son propre état
				// d'erreur au mount.
				await Promise.allSettled([
					queryClient.prefetchQuery({
						queryKey: ["schema", teamSlug, connectionId],
						queryFn: () => fetchSchema(connectionId, teamSlug),
						staleTime: 60_000
					}),
					queryClient.prefetchQuery({
						queryKey: ["canvas-state", teamSlug, connectionId],
						queryFn: () => fetchCanvasState(connectionId, teamSlug),
						staleTime: Number.POSITIVE_INFINITY
					})
				]);
				setPendingId(null);
				if (teamSlug) {
					void navigate({
						to: "/team/$teamSlug/canvas/$connId",
						params: { teamSlug, connId: connectionId }
					});
				} else {
					void navigate({
						to: "/canvas/$connId",
						params: { connId: connectionId }
					});
				}
			})();
		},
		[navigate, queryClient, teamSlug]
	);

	return { pendingId, handleClick };
}
