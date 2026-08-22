import { useMemo } from "react";
import { useCurrentTeamSlug } from "../../teams/useCurrentTeam";
import type { LayoutResult } from "../layout";
import type { TableNodeType } from "../TableNode";
import type { AnchorsApi } from "../useEdgeAnchors";
import type { FramesApi } from "../useFrames";
import type { PositionsApi, PositionsMap } from "../useTablePositions";
import type { SizesApi, SizesMap } from "../useTableSizes";
import { useCanvasSync } from "./useCanvasSync";

export interface UseCanvasSyncBridgeOptions {
	/** UUID de la db_connection dont ce canvas dépend — clé de sync serveur.
	 *  Un canvas par (user × connection). */
	readonly connectionId: string;
	readonly baseRef: React.MutableRefObject<LayoutResult | null>;
	readonly setNodes: React.Dispatch<React.SetStateAction<TableNodeType[]>>;
	readonly tablePositions: PositionsApi;
	readonly tableSizes: SizesApi;
	readonly framesApi: FramesApi;
	readonly edgeAnchors: AnchorsApi;
	readonly hiddenIds: ReadonlySet<string>;
	readonly setHiddenIds: React.Dispatch<
		React.SetStateAction<ReadonlySet<string>>
	>;
}

export interface UseCanvasSyncBridgeReturn {
	/** `true` dès que le payload serveur a été appliqué (ou qu'on a confirmé
	 * qu'il n'y en avait pas — 404). Le parent affiche un overlay bloquant
	 * tant que `ready === false` pour masquer le flash du localStorage
	 * résiduel avant hydratation. */
	readonly canvasReady: boolean;
}

/**
 * Encapsule TOUT ce qui touche à la synchro serveur du state canvas :
 *   - Reçoit le `connectionId` (UUID db_connection) — clé du GET/PUT.
 *     La clé n'est plus la signature `${engine}:${tables}` (qui provoquait
 *     des collisions entre 2 dbs partageant le même set de tables).
 *   - Compose `replaceAll` — 5 setters atomiques combinés en un objet stable.
 *   - Wire `useCanvasSync` — GET au mount, observe les 5 slices, PUT debounce
 *     2 s. Skip si user anonyme (le hook interne détecte via `session`).
 *
 * ─── Pourquoi `positions`/`sizes` re-injectent aussi dans les nodes RF ───
 * `useCanvasSync.replaceAll` update les hooks (positions/sizes/frames/hidden/
 * edgeAnchors) mais React Flow garde son propre state `nodes` via
 * `useNodesState` — le `useEffect` de seed dans `useCanvasNodes` lit
 * positions/sizes via *ref* (pour ne PAS re-fire à chaque persistance) →
 * ne se déclenche pas au replaceAll. Sans repush direct dans setNodes,
 * l'hydration serveur (login → payload → replaceAll) update le hook mais
 * PAS les nodes affichés : tables au mauvais endroit après login canvas fresh.
 *
 * ─── Fallback chaîné serveur → ELK base → keep ───
 * Pour un node absent du payload serveur (ou dont width/height est undefined),
 * on retombe sur `baseRef.current` (positions ELK d'origine) — PAS sur les
 * valeurs courantes du node RF, qui peuvent être stales d'un seed pré-login
 * (`persistLocal=true` a chargé le localStorage résiduel). Sans ce fallback,
 * RF continue d'afficher les vieilles dimensions locales tandis que
 * `tableSizes.sizes` (source of truth pour `useCanvasSync`) est vide —
 * divergence permanente + jump au reload suivant.
 */
export function useCanvasSyncBridge(
	opts: UseCanvasSyncBridgeOptions
): UseCanvasSyncBridgeReturn {
	const {
		connectionId,
		baseRef,
		setNodes,
		tablePositions,
		tableSizes,
		framesApi,
		edgeAnchors,
		hiddenIds,
		setHiddenIds
	} = opts;

	const canvasSyncReplaceAll = useMemo(
		() => ({
			positions: (next: PositionsMap) => {
				tablePositions.replaceAll(next);
				const baseById = new Map(
					(baseRef.current?.nodes ?? []).map((n) => [n.id, n])
				);
				setNodes((prev) =>
					prev.map((n) => {
						const p = next[n.id];
						if (p !== undefined) return { ...n, position: p };
						const bn = baseById.get(n.id);
						return bn ? { ...n, position: bn.position } : n;
					})
				);
			},
			sizes: (next: SizesMap) => {
				tableSizes.replaceAll(next);
				const baseById = new Map(
					(baseRef.current?.nodes ?? []).map((n) => [n.id, n])
				);
				setNodes((prev) =>
					prev.map((n) => {
						const s = next[n.id];
						const bn = baseById.get(n.id);
						const w = s?.width ?? bn?.width;
						const h = s?.height ?? bn?.height;
						return {
							...n,
							...(w !== undefined ? { width: w } : {}),
							...(h !== undefined ? { height: h } : {})
						};
					})
				);
			},
			frames: framesApi.replaceAll,
			hidden: (ids: ReadonlySet<string>) => setHiddenIds(new Set(ids)),
			edgeAnchors: edgeAnchors.replaceAll
		}),
		[
			tablePositions.replaceAll,
			tableSizes.replaceAll,
			framesApi.replaceAll,
			edgeAnchors.replaceAll,
			setNodes,
			baseRef,
			setHiddenIds
		]
	);

	const teamSlug = useCurrentTeamSlug();
	const { ready: canvasReady } = useCanvasSync({
		connectionId,
		teamSlug,
		positions: tablePositions.positions,
		sizes: tableSizes.sizes,
		frames: framesApi.frames,
		hidden: hiddenIds,
		edgeAnchors: edgeAnchors.overrides,
		replaceAll: canvasSyncReplaceAll
	});

	return { canvasReady };
}
