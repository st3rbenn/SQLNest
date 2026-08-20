import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type MouseEvent, useCallback, useState } from "react";
import { notifyError } from "../notifications/notify";
import { fetchCanvasState } from "../schema/canvas/canvasStateClient";
import {
	canvasLayoutQueryKey,
	computeCanvasLayout
} from "../schema/SchemaCanvas";
import { fetchSchema } from "../schema/useSchema";
import { useCurrentTeamSlug } from "../teams/useCurrentTeam";

/**
 * Warm le cache TanStack pour un canvas : schema (bloquant) + layout ELK
 * (bloquant, fallback silencieux si KO) + canvas_state (best-effort en
 * parallèle). Après ça, le composant canvas mount et rend instantanément.
 *
 * Utilisé par `useNavigateToCanvas` (click gallery) et par `PairPage`
 * (redirect post-approve ADR-022 Q5a) — sans ce prefetch, l'user arrive
 * sur un fond canvas noir pendant 1-3 s le temps que `useSchema` résolve.
 */
export async function prefetchCanvasData(
	queryClient: QueryClient,
	teamSlug: string | null,
	connectionId: string
): Promise<void> {
	void queryClient.prefetchQuery({
		queryKey: ["canvas-state", teamSlug, connectionId],
		queryFn: () => fetchCanvasState(connectionId, teamSlug),
		staleTime: Number.POSITIVE_INFINITY
	});
	const schema = await queryClient.ensureQueryData({
		queryKey: ["schema", teamSlug, connectionId],
		queryFn: () => fetchSchema(connectionId, teamSlug),
		staleTime: 60_000
	});
	try {
		await queryClient.ensureQueryData({
			queryKey: canvasLayoutQueryKey(connectionId),
			queryFn: () => computeCanvasLayout(schema),
			staleTime: Number.POSITIVE_INFINITY,
			gcTime: Number.POSITIVE_INFINITY
		});
	} catch {
		// Layout KO → le canvas mount quand même et fallback ELK au mount.
	}
}

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
				try {
					await prefetchCanvasData(queryClient, teamSlug, connectionId);
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
				} catch (err) {
					// Fetch schema échoue → notif + rester sur la gallery.
					// L'user retrouve son contexte, la notif indique la raison
					// (CLI offline, timeout, backend down…).
					notifyError(
						err instanceof Error ? err.message : "Impossible d'ouvrir le canvas"
					);
				} finally {
					setPendingId(null);
				}
			})();
		},
		[navigate, queryClient, teamSlug]
	);

	return { pendingId, handleClick };
}
