/**
 * Sync serveur du snapshot de preview (C.15).
 *
 * Rôle : chaque fois que le user modifie son canvas (drag table, resize,
 * create/rename/delete frame, hide), on compute un snapshot léger du
 * rendu courant et on PUT `/api/db-connections/:id/preview-snapshot`.
 *
 * Ce snapshot sert de **fallback rendu** pour `MiniSchemaPreview` dans la
 * gallery quand le CLI est offline — au lieu d'afficher « CLI hors ligne »
 * vide, on re-render depuis le snapshot (theme-aware, ~2-10 KB JSON).
 *
 * ─── Design ────────────────────────────────────────────────────────────
 * Séparé de `useCanvasSync` (qui persiste `canvas_state.payload`) pour
 * garder les responsabilités distinctes :
 *  - canvas_state = positions/sizes/frames/hidden/edgeAnchors bruts,
 *    hydratés au mount du canvas.
 *  - preview_snapshot = rendu précalculé, jamais lu par le canvas lui-même,
 *    seulement par la gallery.
 *
 * ─── Débounce court (1.5 s) ────────────────────────────────────────────
 * Précédemment 5 s — trop long : un user qui ouvre le canvas et repart
 * en < 5 s perdait tout le snapshot (le cleanup effect clear le timeout
 * au unmount avant qu'il ne fire). Bug rapporté par Anthonin 2026-08-07.
 *
 * ─── Flush au unmount + fermeture d'onglet ─────────────────────────────
 * Pattern miroir de `useCanvasSync` — 3 events pour couvrir tous les
 * scénarios de départ :
 *  - cleanup useEffect (navigation SPA canvas → gallery / switch canvas)
 *  - `beforeunload` + `pagehide` (fermeture d'onglet, refresh)
 *  - `visibilitychange` (mobile / background tab)
 *
 * Chaque flush utilise `fetch({ keepalive: true })` — la request continue
 * même si le document disparaît. Cap 60 KB (spec HTML keepalive) : les
 * snapshots typiques font 2-10 KB, largement sous le seuil.
 *
 * ─── Gate ──────────────────────────────────────────────────────────────
 * User anonyme → no-op (pas de compte, pas de gallery, pas de snapshot).
 * `canvasReady = false` → skip (on ne veut pas PUT un snapshot vide avant
 * que useCanvasSync ait finit son hydratation initiale).
 */

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";
import { useCurrentUser } from "../../auth/sessionQuery";
import {
	type PreviewSnapshot,
	putPreviewSnapshot
} from "../../db-connections/previewSnapshotClient";
import { useCurrentTeamSlug } from "../../teams/useCurrentTeam";
import type { Frame } from "../frames";

/** Débounce court — 1.5 s. Assez pour dedup les changements en rafale
 *  (drag qui émet N mousemove) mais assez court pour que le user qui
 *  ouvre-modifie-repart en 3-4 s n'ait pas perdu son snapshot. */
export const PREVIEW_SNAPSHOT_DEBOUNCE_MS = 1500;

export interface UsePreviewSnapshotSyncOptions {
	readonly connectionId: string;
	/** `true` quand useCanvasSync a fini son hydratation initiale — évite
	 *  de PUT un snapshot vide avant que les positions server soient
	 *  chargées dans le state React. */
	readonly canvasReady: boolean;
	/** Nodes React Flow (tables uniquement — pas les frames RF). Chaque node
	 *  a position + width/height après resize. */
	readonly tableNodes: ReadonlyArray<{
		readonly id: string;
		readonly position: { x: number; y: number };
		readonly width?: number | null;
		readonly height?: number | null;
	}>;
	readonly frames: readonly Frame[];
	/** Relations du SchemaModel — { from: { collection }, to: { collection } }. */
	readonly relations: ReadonlyArray<{
		readonly from: { readonly collection: string };
		readonly to: { readonly collection: string };
	}>;
	/** Tables masquées — exclues du snapshot pour matcher ce que l'user voit. */
	readonly hiddenIds: ReadonlySet<string>;
}

/** Compute le snapshot depuis le state courant. Filtre les tables masquées
 *  et les frames dont TOUS les membres sont masqués (les frames-seed
 *  hérités calculent leur rect dynamiquement — pas de rect fixe à
 *  persister, on skip). */
export function computePreviewSnapshot(
	opts: Omit<UsePreviewSnapshotSyncOptions, "connectionId" | "canvasReady">
): PreviewSnapshot {
	const nodes: PreviewSnapshot["nodes"] = [];
	const nodesByName = new Map<
		string,
		{ x: number; y: number; w: number; h: number }
	>();
	for (const n of opts.tableNodes) {
		if (opts.hiddenIds.has(n.id)) continue;
		if (n.width == null || n.height == null) continue;
		const entry = {
			id: n.id,
			x: n.position.x,
			y: n.position.y,
			w: n.width,
			h: n.height
		};
		nodes.push(entry);
		nodesByName.set(n.id, {
			x: entry.x,
			y: entry.y,
			w: entry.w,
			h: entry.h
		});
	}

	const nodeSet = new Set(nodes.map((n) => n.id));
	const edges: PreviewSnapshot["edges"] = [];
	for (const r of opts.relations) {
		if (!nodeSet.has(r.from.collection) || !nodeSet.has(r.to.collection)) {
			continue;
		}
		edges.push({ source: r.from.collection, target: r.to.collection });
	}

	const frames: PreviewSnapshot["frames"] = [];
	for (const f of opts.frames) {
		let rect = f.rect;
		if (!rect) {
			// Frame-seed sans rect ancré : bbox des membres présents.
			let minX = Number.POSITIVE_INFINITY;
			let minY = Number.POSITIVE_INFINITY;
			let maxX = Number.NEGATIVE_INFINITY;
			let maxY = Number.NEGATIVE_INFINITY;
			let seen = false;
			for (const name of f.collections) {
				const n = nodesByName.get(name);
				if (!n) continue;
				seen = true;
				if (n.x < minX) minX = n.x;
				if (n.y < minY) minY = n.y;
				if (n.x + n.w > maxX) maxX = n.x + n.w;
				if (n.y + n.h > maxY) maxY = n.y + n.h;
			}
			if (!seen) continue;
			const PAD = 16;
			rect = {
				x: minX - PAD,
				y: minY - PAD,
				width: maxX - minX + PAD * 2,
				height: maxY - minY + PAD * 2
			};
		}
		frames.push({
			key: f.key,
			label: f.label,
			hue: f.hue,
			x: rect.x,
			y: rect.y,
			w: rect.width,
			h: rect.height
		});
	}

	return { nodes, edges, frames };
}

/** Un push planifié : capture (connectionId, snapshot) au moment de l'armement
 *  pour permettre un flush à un moment où l'user pourrait avoir déjà changé
 *  de connectionId ou dérivé le snapshot. */
interface PendingPush {
	readonly connectionId: string;
	readonly snapshot: PreviewSnapshot;
	readonly serialized: string;
}

/** Seuil sécurité `fetch({ keepalive: true })` — spec HTML limite à 64 KiB
 *  total en vol par origin. On garde une marge pour headers/wrapping. */
const KEEPALIVE_MAX_BODY_BYTES = 60_000;

export function usePreviewSnapshotSync(
	opts: UsePreviewSnapshotSyncOptions
): void {
	const { data: session } = useCurrentUser();
	const teamSlug = useCurrentTeamSlug();
	const enabled =
		session?.user != null && opts.connectionId.length > 0 && opts.canvasReady;
	const queryClient = useQueryClient();

	const snapshot = useMemo(
		() =>
			computePreviewSnapshot({
				tableNodes: opts.tableNodes,
				frames: opts.frames,
				relations: opts.relations,
				hiddenIds: opts.hiddenIds
			}),
		[opts.tableNodes, opts.frames, opts.relations, opts.hiddenIds]
	);

	// Sérialisation stable — comparaison par référence de string pour
	// détecter les vrais changements (dedup les re-renders sans mutation).
	const serialized = useMemo(() => JSON.stringify(snapshot), [snapshot]);
	const lastSyncedRef = useRef<string | null>(null);
	const timeoutRef = useRef<number | null>(null);
	// Le dernier PendingPush armé — utilisé par le flush au unmount et par
	// les listeners de fermeture d'onglet pour envoyer la version la plus
	// fraîche même si le débounce n'a pas encore fire.
	const pendingRef = useRef<PendingPush | null>(null);

	// ─── Effet push : premier immédiat, suivants debounce ─────────────
	// Le premier snapshot d'une session DOIT partir immédiatement : sinon
	// l'user qui ouvre le canvas et quitte en < 1.5 s perd la preview
	// (bug apollon_db 2026-08-07). Les changements suivants (drag, resize,
	// frames) sont debounced normalement pour dedup les rafales.
	useEffect(() => {
		if (!enabled) return;
		if (snapshot.nodes.length === 0) return;
		if (serialized === lastSyncedRef.current) return;

		const pending: PendingPush = {
			connectionId: opts.connectionId,
			snapshot,
			serialized
		};

		const isFirstSnapshotThisSession = lastSyncedRef.current === null;
		if (isFirstSnapshotThisSession) {
			// PUT immédiat — la preview de cette connection dans la gallery
			// affichera un rendu fidèle même si l'user quitte tout de suite.
			// On pose `lastSyncedRef` OPTIMISTE avant le PUT pour éviter que
			// les renders suivants (avant que la promise settle) re-fire cet
			// effet et ne PUT une deuxième fois.
			lastSyncedRef.current = pending.serialized;
			putPreviewSnapshot(pending.connectionId, pending.snapshot, {
				teamSlug
			})
				.then(() => {
					void queryClient.invalidateQueries({
						queryKey: ["db-connections"]
					});
				})
				.catch(() => {
					// Revert le baseline pour retry au prochain change.
					lastSyncedRef.current = null;
				});
			return;
		}

		// Changements suivants : debounce classique.
		if (timeoutRef.current !== null) {
			window.clearTimeout(timeoutRef.current);
		}
		pendingRef.current = pending;
		timeoutRef.current = window.setTimeout(() => {
			timeoutRef.current = null;
			const p = pendingRef.current;
			pendingRef.current = null;
			if (p === null) return;
			putPreviewSnapshot(p.connectionId, p.snapshot, { teamSlug })
				.then(() => {
					lastSyncedRef.current = p.serialized;
					void queryClient.invalidateQueries({
						queryKey: ["db-connections"]
					});
				})
				.catch(() => {
					// Best-effort. Un échec (401 session, 500, 413) ne bloque
					// JAMAIS le canvas. Retry au prochain change.
				});
		}, PREVIEW_SNAPSHOT_DEBOUNCE_MS);
	}, [enabled, snapshot, serialized, opts.connectionId, queryClient, teamSlug]);

	// ─── Flush au unmount + fermeture d'onglet ────────────────────────
	// Pattern miroir useCanvasSync. Un `pendingRef` non-null au moment du
	// unmount signifie qu'un PUT est planifié mais n'a pas fire — on
	// l'envoie immédiatement via `fetch({ keepalive: true })` qui survit
	// à la disparition du document.
	//
	// Deps vide → l'effet install les listeners une seule fois au mount ;
	// `pendingRef` capture la connectionId à l'armement (via l'effet ci-dessus),
	// pas besoin de recréer les listeners au switch de canvas.
	useEffect(() => {
		function flushPending(): void {
			const pending = pendingRef.current;
			if (pending === null) return;
			if (timeoutRef.current !== null) {
				window.clearTimeout(timeoutRef.current);
				timeoutRef.current = null;
			}
			pendingRef.current = null;
			try {
				const body = JSON.stringify({ snapshot: pending.snapshot });
				if (body.length >= KEEPALIVE_MAX_BODY_BYTES) return;
				void putPreviewSnapshot(pending.connectionId, pending.snapshot, {
					keepalive: true,
					teamSlug
				}).catch(() => {
					// Silencieux — le document part.
				});
			} catch {
				// Sérialisation impossible (rare) — no-op.
			}
		}

		function onVisibilityChange(): void {
			if (document.visibilityState === "hidden") flushPending();
		}

		window.addEventListener("beforeunload", flushPending);
		window.addEventListener("pagehide", flushPending);
		document.addEventListener("visibilitychange", onVisibilityChange);
		return () => {
			flushPending();
			window.removeEventListener("beforeunload", flushPending);
			window.removeEventListener("pagehide", flushPending);
			document.removeEventListener("visibilitychange", onVisibilityChange);
		};
	}, [teamSlug]);
}
