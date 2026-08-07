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
 * Le débounce est plus large (5 s vs 2 s pour canvas_state) : la preview
 * n'a pas besoin d'être à la seconde près — l'user ne la voit pas pendant
 * qu'il travaille dans le canvas.
 *
 * ─── Gate ──────────────────────────────────────────────────────────────
 * User anonyme → no-op (pas de compte, pas de gallery, pas de snapshot).
 * `hydrated` = false → skip (on ne veut pas PUT un snapshot vide avant
 * que useCanvasSync ait finit son hydratation initiale).
 */

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";
import { useCurrentUser } from "../../auth/sessionQuery";
import {
	type PreviewSnapshot,
	putPreviewSnapshot
} from "../../db-connections/previewSnapshotClient";
import type { Frame } from "../frames";

/** Débounce plus long que useCanvasSync — la preview n'a pas besoin d'être
 *  à la seconde près. */
export const PREVIEW_SNAPSHOT_DEBOUNCE_MS = 5000;

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

export function usePreviewSnapshotSync(
	opts: UsePreviewSnapshotSyncOptions
): void {
	const { data: session } = useCurrentUser();
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

	useEffect(() => {
		if (!enabled) return;
		// Skip si snapshot vide (canvas pas encore prêt) OU si identique au
		// dernier envoyé.
		if (snapshot.nodes.length === 0) return;
		if (serialized === lastSyncedRef.current) return;

		if (timeoutRef.current !== null) {
			window.clearTimeout(timeoutRef.current);
		}
		timeoutRef.current = window.setTimeout(() => {
			timeoutRef.current = null;
			putPreviewSnapshot(opts.connectionId, snapshot)
				.then(() => {
					lastSyncedRef.current = serialized;
					// Invalide `db-connections` pour que la gallery re-fetch
					// et pick le nouveau snapshot au prochain retour. Pas
					// urgent : la nav gallery ré-fetch de toute façon (poll 5s).
					void queryClient.invalidateQueries({
						queryKey: ["db-connections"]
					});
				})
				.catch(() => {
					// Best-effort. Un échec (401 session expirée, 500 backend,
					// 413 payload trop gros) ne bloque JAMAIS le canvas.
					// On retentera au prochain change.
				});
		}, PREVIEW_SNAPSHOT_DEBOUNCE_MS);

		return () => {
			if (timeoutRef.current !== null) {
				window.clearTimeout(timeoutRef.current);
				timeoutRef.current = null;
			}
		};
	}, [enabled, snapshot, serialized, opts.connectionId, queryClient]);
}
