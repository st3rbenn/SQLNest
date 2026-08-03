import type { Node } from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { showNotification } from "@sqlnest/design-system";
import type { FrameNodeType } from "../FrameNode";
import { type Frame, type FrameRect, rectContainsPoint } from "../frames";
import type { LayoutResult } from "../layout";
import { NODE_WIDTH, nodeHeight } from "../TableNode";
import type { TableNodeType } from "../TableNode";
import type { FramesApi } from "../useFrames";
import type { PositionsApi, XY } from "../useTablePositions";
import {
	boundsOfTables,
	computeFrameNodes,
	FRAME_PAD
} from "./computeFrameNodes";

export interface UseCanvasFramesOptions {
	readonly base: LayoutResult | null;
	readonly nodes: readonly TableNodeType[];
	readonly nodesRef: React.MutableRefObject<TableNodeType[]>;
	readonly setNodes: React.Dispatch<
		React.SetStateAction<TableNodeType[]>
	>;
	readonly hiddenIds: ReadonlySet<string>;
	readonly framesApi: FramesApi;
	readonly tablePositions: PositionsApi;
	readonly history: { readonly push: () => void };
	readonly focusFrame: (key: string) => void;
}

export interface UseCanvasFramesReturn {
	readonly frameNodes: FrameNodeType[];
	/** Rename inline (double-clic sur le badge d'un frame → input Enter).
	 * Aussi consommé par le drawer `FrameDetails`. */
	readonly handleFrameRename: (key: string, label: string) => void;
	/** Right-click sur le badge d'un frame OU depuis le drawer `FrameDetails`. */
	readonly handleFrameDelete: (key: string) => void;
	/** Handlers React Flow — à passer tel quel à `<ReactFlow>`.
	 * Ils gèrent DEUX chemins (frame drag vs table drag) selon `node.type`. */
	readonly onNodeDragStart: (
		_: unknown,
		node: Node
	) => void;
	readonly onNodeDrag: (_: unknown, node: Node) => void;
	readonly onNodeDragStop: (_: unknown, node: Node) => void;
}

/**
 * Orchestre TOUT ce qui touche aux frames :
 *   - `frameNodes` composé via `computeFrameNodes` — nœuds RF de type
 *     `frame` avec handlers resize/rename/delete/focus bindés.
 *   - Membership reconciliation post-ELK : un frame sans rect persisté (ex.
 *     seed statique) reçoit le bounding-box de ses membres calculés depuis
 *     les positions ELK — une seule fois par changement de `base`.
 *   - `handleFrameResize` : reconciliation membership au release du
 *     NodeResizer (membre dont le centre tombe hors rect → détaché).
 *   - Drag lifecycle avec `frameDragStateRef` — snapshot des positions au
 *     drag-start, delta absolu appliqué à chaque drag-tick (immune au
 *     batching React 18 qui coalescerait des dx naïfs), reconciliation
 *     membership au drag-stop d'une table.
 */
export function useCanvasFrames(
	opts: UseCanvasFramesOptions
): UseCanvasFramesReturn {
	const {
		base,
		nodes,
		nodesRef,
		setNodes,
		hiddenIds,
		framesApi,
		tablePositions,
		history,
		focusFrame
	} = opts;

	// Ref pour les closures event handlers — évite de rebuilder les
	// callbacks à chaque render de framesApi.
	const framesApiRef = useRef(framesApi);
	framesApiRef.current = framesApi;
	const frameDragStateRef = useRef<{
		frameKey: string;
		frameOrigin: { x: number; y: number };
		rectSize: { width: number; height: number };
		memberOrigins: Map<string, { x: number; y: number }>;
	} | null>(null);

	// Post-ELK : fige le rect des frames-seed depuis les positions ELK.
	// Un frame-seed n'a pas de rect persisté (c'est le rôle de ce
	// `useEffect` de le calculer une fois puis de le sauver). Les frames
	// user-created ont déjà leur rect posé au moment du `createFrame`.
	//
	// Note : plus de filtre "membre hors du rect → remove". Avec les
	// positions persistées, le rect + la membership sont indépendants —
	// un membre peut être temporairement hors rect (ex. ajouté via
	// context menu sans être déplacé). Le retirer automatiquement
	// provoquait un bug drag : la table "abandonnée" restait en place
	// alors que le frame se déplaçait.
	const membershipRefreshedFor = useRef<LayoutResult | null>(null);
	useEffect(() => {
		if (base === null || nodes.length === 0) return;
		if (membershipRefreshedFor.current === base) return;
		membershipRefreshedFor.current = base;
		const byId = new Map(nodes.map((n) => [n.id, n]));
		for (const frame of framesApi.frames) {
			if (frame.rect) continue;
			const members = frame.collections
				.map((c) => byId.get(c))
				.filter((n): n is TableNodeType => n !== undefined);
			const rect = boundsOfTables(members, FRAME_PAD);
			if (rect) framesApi.setFrameRect(frame.key, rect);
		}
		// biome-ignore lint/correctness/useExhaustiveDependencies: framesApi lu via closure — ok car le ref garantit exec unique
	}, [base, nodes]);

	// `handleFrameResize` : callback du NodeResizer d'un frame. Le rect
	// a déjà été persisté en direct par `handleNodesChange` (intercept
	// live). Ici on ne fait QUE la reconciliation membership : table dont
	// le centre tombe HORS du rect final → retirée du frame (sinon un
	// drag du frame la ferait suivre alors qu'elle est visuellement
	// dehors). Pas de nouveau `setFrameRect` — c'était un doublon qui
	// écrasait le rect live avec le rect final tel que reçu du
	// NodeResizer (précision floats + timing) et qui semblait provoquer
	// des jumps + un état bancal empêchant le drag suivant.
	const handleFrameResize = useCallback(
		(key: string, newRect: FrameRect) => {
			const api = framesApiRef.current;
			const frame = api.frames.find((f) => f.key === key);
			if (!frame) return;
			const byId = new Map(nodesRef.current.map((n) => [n.id, n]));
			for (const memberName of frame.collections) {
				const node = byId.get(memberName);
				if (!node) continue;
				const w = node.width ?? NODE_WIDTH;
				const h = node.height ?? nodeHeight(node.data.collection);
				const center = {
					x: node.position.x + w / 2,
					y: node.position.y + h / 2
				};
				if (!rectContainsPoint(newRect, center)) {
					api.removeTableFromFrame(memberName);
				}
			}
			history.push();
		},
		[history, nodesRef]
	);

	const handleFrameRename = useCallback(
		(key: string, label: string) => {
			framesApi.renameFrame(key, label);
			history.push();
		},
		[framesApi, history]
	);

	const handleFrameDelete = useCallback(
		(key: string) => {
			const frame = framesApi.frames.find((f) => f.key === key);
			framesApi.removeFrame(key);
			if (frame) {
				showNotification({
					title: `Frame « ${frame.label} » supprimé`,
					message: `${frame.collections.length} table${frame.collections.length > 1 ? "s" : ""} conservée${frame.collections.length > 1 ? "s" : ""}.`,
					color: "blue",
					autoClose: 2500
				});
			}
			history.push();
		},
		[framesApi, history]
	);

	const handleFrameFocus = useCallback(
		(key: string) => focusFrame(key),
		[focusFrame]
	);

	const frameNodes = useMemo(
		() =>
			computeFrameNodes(
				framesApi.frames,
				nodes.filter((n) => !hiddenIds.has(n.id)),
				handleFrameResize,
				handleFrameRename,
				handleFrameDelete,
				handleFrameFocus
			),
		[
			framesApi.frames,
			nodes,
			hiddenIds,
			handleFrameResize,
			handleFrameRename,
			handleFrameDelete,
			handleFrameFocus
		]
	);

	// ─── Drag lifecycle ──────────────────────────────────────────────
	// Delta ABSOLU depuis snapshot au drag-start — immune au batching
	// React 18 (plusieurs mousemove peuvent tirer avant qu'un setFrameRect
	// ait committé ; dx naïf `node.position - frame.rect` exploserait, les
	// membres dériveraient plus vite que le frame).
	const onNodeDragStart = useCallback(
		(_: unknown, node: Node) => {
			if ((node as { type?: string }).type !== "frame") return;
			const frameKey = node.id.replace(/^frame:/, "");
			const frame = framesApiRef.current.frames.find((f) => f.key === frameKey);
			if (!frame || !frame.rect) return;
			const members = new Set(frame.collections);
			const memberOrigins = new Map<string, { x: number; y: number }>();
			for (const n of nodesRef.current) {
				if (members.has(n.id))
					memberOrigins.set(n.id, { x: n.position.x, y: n.position.y });
			}
			frameDragStateRef.current = {
				frameKey,
				frameOrigin: { x: node.position.x, y: node.position.y },
				rectSize: { width: frame.rect.width, height: frame.rect.height },
				memberOrigins
			};
		},
		[nodesRef]
	);

	const onNodeDrag = useCallback(
		(_: unknown, node: Node) => {
			if ((node as { type?: string }).type !== "frame") return;
			const state = frameDragStateRef.current;
			if (!state) return;
			const dx = node.position.x - state.frameOrigin.x;
			const dy = node.position.y - state.frameOrigin.y;
			setNodes((ns) =>
				ns.map((n) => {
					const origin = state.memberOrigins.get(n.id);
					if (!origin) return n;
					return {
						...n,
						position: { x: origin.x + dx, y: origin.y + dy }
					};
				})
			);
			framesApiRef.current.setFrameRect(state.frameKey, {
				x: node.position.x,
				y: node.position.y,
				width: state.rectSize.width,
				height: state.rectSize.height
			});
		},
		[setNodes]
	);

	const onNodeDragStop = useCallback(
		(_: unknown, node: Node) => {
			// Drag d'un frame → persiste les positions finales de ses
			// membres (ceux-ci ont été shiftés en direct par `onNodeDrag`).
			// Le rect du frame est déjà persisté via `setFrameRect` dans
			// `onNodeDrag`. Sans ça, un refresh restaurerait le rect mais
			// pas les tables → membership fantôme, filtre nettoie, frame
			// vide.
			if ((node as { type?: string }).type === "frame") {
				const state = frameDragStateRef.current;
				frameDragStateRef.current = null;
				if (!state) return;
				const entries: Record<string, XY> = {};
				for (const n of nodesRef.current) {
					if (state.memberOrigins.has(n.id)) entries[n.id] = n.position;
				}
				if (Object.keys(entries).length > 0) {
					tablePositions.setManyPositions(entries);
				}
				history.push();
				return;
			}
			// Une table posée : recalcule son appartenance à un frame en
			// testant si son centre est dans un rect. Une seule frame par
			// table (celui du dessous emporte s'il y a chevauchement, ce
			// qui est rare avec des frames non-imbriqués).
			const w = (node as { width?: number }).width ?? NODE_WIDTH;
			const h = (node as { height?: number }).height ?? 200;
			const center = {
				x: node.position.x + w / 2,
				y: node.position.y + h / 2
			};
			// Membership au drag (comme Figma) :
			// - drop dans un frame ≠ actuel → add (drag-in ou switch)
			// - drop en dehors de tout frame → remove (drag-out)
			// - drop dans le frame actuel → no-op (repositionnement interne)
			const api = framesApiRef.current;
			const current = api.frameOfTable(node.id);
			let dropped: Frame | null = null;
			for (const f of api.frames) {
				if (!f.rect) continue;
				if (rectContainsPoint(f.rect, center)) {
					dropped = f;
					break;
				}
			}
			if (dropped && (!current || current.key !== dropped.key)) {
				api.addTableToFrame(dropped.key, node.id);
			} else if (!dropped && current) {
				api.removeTableFromFrame(node.id);
			}
			// Persiste la position finale (survit au refresh).
			tablePositions.setPosition(node.id, node.position);
			history.push();
		},
		[tablePositions, history, nodesRef]
	);

	return {
		frameNodes,
		handleFrameRename,
		handleFrameDelete,
		onNodeDragStart,
		onNodeDrag,
		onNodeDragStop
	};
}
