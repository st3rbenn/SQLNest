import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type MouseEvent, useCallback, useState } from "react";
import { fetchSchema } from "../schema/useSchema";

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
				try {
					await queryClient.prefetchQuery({
						queryKey: ["schema", connectionId],
						queryFn: () => fetchSchema(connectionId),
						// Aligné sur useSchema — le queryClient default est 60s.
						staleTime: 60_000
					});
				} catch {
					// Prefetch KO (503 CLI hors ligne, 404, …). On navigate
					// quand même — le canvas montrera son propre état d'erreur.
				}
				setPendingId(null);
				void navigate({
					to: "/canvas/$connId",
					params: { connId: connectionId }
				});
			})();
		},
		[navigate, queryClient]
	);

	return { pendingId, handleClick };
}
