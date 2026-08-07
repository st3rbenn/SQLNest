import type { Edge } from "@xyflow/react";
import { useMemo } from "react";
import { bestHandles, type Side, spreadOffsets } from "../edgeRouting";
import type { InteractiveEdgeData } from "../InteractiveEdge";
import type { LayoutResult } from "../layout";
import type { TableNodeType } from "../TableNode";
import { NODE_WIDTH, nodeHeight } from "../TableNode";
import type { AnchorMap } from "../useEdgeAnchors";

// Couleurs edges (dupliquées volontairement avec SchemaCanvas pour éviter
// une import cyclique. Une future extraction commune dans `constants.ts`
// est possible mais pas nécessaire tant que ces valeurs restent stables.)
const DECLARED = "#0d99ff";
const INFERRED = "#ffc933";
const DIM = "#7a7a7a";

export interface UseCanvasEdgesOptions {
	readonly base: LayoutResult | null;
	readonly nodes: readonly TableNodeType[];
	readonly hiddenIds: ReadonlySet<string>;
	readonly focusId: string | null;
	readonly edgeAnchors: {
		readonly overrides: AnchorMap;
		readonly setOverride: (
			edgeId: string,
			end: "source" | "target",
			side: Side
		) => void;
		readonly clearOverride: (edgeId: string) => void;
	};
}

export interface UseCanvasEdgesReturn {
	readonly displayEdges: Edge[];
	/** Voisinage FK direct du nœud focalisé (le nœud + ses 1-sauts). `null`
	 * quand aucun focus — utilisé par `displayTableNodes` pour appliquer
	 * `dim` sur les tables hors chemin de focus. */
	readonly neighbors: ReadonlySet<string> | null;
}

/**
 * Dérive tous les artefacts liés aux edges à partir du layout ELK, des
 * nodes RF vivants, des overrides d'ancres user et du focus courant.
 *
 * Rôle central : **routing edges + spread offset contra-sens**. Sans ce
 * hook, deux edges qui touchent le même côté d'un node (un sortant + un
 * rentrant) se superposent au mid-side, impossibles à cibler individuellement.
 *
 * ─── Pipeline 4 passes ────────────────────────────────────────────────
 * 1. Filtrer les edges dont source/target est masquée.
 * 2. Résoudre `sourceHandle`/`targetHandle` (override user > auto-routing
 *    `bestHandles` basé sur les positions relatives).
 * 3. Grouper TOUS les endpoints par (nodeId, side), source et target
 *    confondus → si N edges touchent le même handle, on distribue leurs
 *    endpoints avec `spreadOffsets(N)`.
 * 4. Composer l'edge final (style focus/dim, offsets dans `data` lus par
 *    `InteractiveEdge`).
 */
export function useCanvasEdges(
	opts: UseCanvasEdgesOptions
): UseCanvasEdgesReturn {
	const { base, nodes, hiddenIds, focusId, edgeAnchors } = opts;

	const neighbors = useMemo(() => {
		if (focusId === null || base === null) return null;
		const set = new Set<string>([focusId]);
		for (const e of base.edges) {
			if (e.source === focusId) set.add(e.target);
			if (e.target === focusId) set.add(e.source);
		}
		return set;
	}, [focusId, base]);

	// Index rapide pour l'auto-routing des edges — évite un O(n) par edge.
	const nodeById = useMemo(() => {
		const map = new Map<string, TableNodeType>();
		for (const n of nodes) map.set(n.id, n);
		return map;
	}, [nodes]);

	// Enveloppe stable pour passer les setters d'ancres aux edges via
	// `data` — recréée seulement si l'API change (refs stables via
	// useCallback dans useEdgeAnchors).
	const anchorApi = useMemo<InteractiveEdgeData>(
		() => ({
			setOverride: edgeAnchors.setOverride,
			clearOverride: edgeAnchors.clearOverride
		}),
		[edgeAnchors.setOverride, edgeAnchors.clearOverride]
	);

	const displayEdges = useMemo(() => {
		const visible = (base?.edges ?? []).filter(
			(e) => !hiddenIds.has(e.source) && !hiddenIds.has(e.target)
		);
		// Pass 1 : résout side source + side target de chaque edge
		// (override > auto-routing). Sert de base au groupement offset.
		const resolved = visible.map((e) => {
			const src = nodeById.get(e.source);
			const tgt = nodeById.get(e.target);
			const auto =
				src && tgt
					? bestHandles(
							{
								x: src.position.x,
								y: src.position.y,
								width: src.width ?? NODE_WIDTH,
								height: src.height ?? nodeHeight(src.data.collection)
							},
							{
								x: tgt.position.x,
								y: tgt.position.y,
								width: tgt.width ?? NODE_WIDTH,
								height: tgt.height ?? nodeHeight(tgt.data.collection)
							}
						)
					: null;
			const override = edgeAnchors.overrides[e.id];
			const sourceHandle: Side | undefined = override?.source ?? auto?.source;
			const targetHandle: Side | undefined = override?.target ?? auto?.target;
			return { edge: e, sourceHandle, targetHandle };
		});

		// Pass 2 : groupe TOUS les endpoints qui touchent le même (nodeId, side),
		// SOURCE ET TARGET CONFONDUS. Un edge sortant et un edge rentrant du
		// même côté d'un même node doivent s'écarter comme deux edges du même
		// sens — sinon chacun se retrouve seul dans son groupe (SRC ou TGT) et
		// atterrit au mid-side, ce qui les fait se superposer visuellement.
		type HandleEntry = { edgeId: string; end: "source" | "target" };
		const handleGroups = new Map<string, HandleEntry[]>();
		for (const { edge, sourceHandle, targetHandle } of resolved) {
			if (sourceHandle) {
				const key = `${edge.source}:${sourceHandle}`;
				const list = handleGroups.get(key) ?? [];
				list.push({ edgeId: edge.id, end: "source" });
				handleGroups.set(key, list);
			}
			if (targetHandle) {
				const key = `${edge.target}:${targetHandle}`;
				const list = handleGroups.get(key) ?? [];
				list.push({ edgeId: edge.id, end: "target" });
				handleGroups.set(key, list);
			}
		}
		// Pass 3 : distribue les ratios sur le groupe unifié (l'ordre reflète
		// l'ordre d'itération des edges — déterministe depuis ELK).
		const offsets = new Map<string, { source?: number; target?: number }>();
		for (const [, entries] of handleGroups) {
			const ratios = spreadOffsets(entries.length);
			entries.forEach((entry, i) => {
				const r = ratios[i];
				// `spreadOffsets(n)` renvoie exactement n éléments — guard TS car
				// l'index-access sur array est typé `T | undefined`.
				if (r === undefined) return;
				const prev = offsets.get(entry.edgeId) ?? {};
				offsets.set(
					entry.edgeId,
					entry.end === "source"
						? { ...prev, source: r }
						: { ...prev, target: r }
				);
			});
		}

		// Pass 4 : compose l'edge final (styles + handles + data avec offsets).
		return resolved.map(({ edge: e, sourceHandle, targetHandle }) => {
			const touchesFocus =
				focusId !== null && (e.source === focusId || e.target === focusId);
			const dim = focusId !== null && !touchesFocus;
			const inferred = (e.data as { inferred?: boolean })?.inferred;
			const o = offsets.get(e.id);
			return {
				...e,
				...(sourceHandle !== undefined ? { sourceHandle } : {}),
				...(targetHandle !== undefined ? { targetHandle } : {}),
				style: {
					...e.style,
					stroke: dim ? DIM : inferred ? INFERRED : DECLARED,
					strokeWidth: touchesFocus ? 2.5 : 1.5,
					opacity: dim ? 0.5 : 1
				},
				zIndex: touchesFocus ? 10 : 0,
				data: {
					...(e.data ?? {}),
					...anchorApi,
					sourceOffsetRatio: o?.source ?? 0,
					targetOffsetRatio: o?.target ?? 0
				}
			};
		});
	}, [base, focusId, hiddenIds, nodeById, edgeAnchors.overrides, anchorApi]);

	return { displayEdges, neighbors };
}
