import type { Node } from "@sqlnest/canvas";
import { showNotification } from "@sqlnest/design-system";
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { FrameNodeType } from "../FrameNode";
import type { FrameRect } from "../frames";
import type { LayoutResult } from "../layout";
import type { TableNodeType } from "../TableNode";
import type { FramesApi } from "../useFrames";
import type { PositionsApi } from "../useTablePositions";
import {
	boundsOfTables,
	computeFrameNodes,
	FRAME_PAD
} from "./computeFrameNodes";
import { fitLegacyFrames } from "./frameTree";

export interface UseCanvasFramesOptions {
	readonly base: LayoutResult | null;
	readonly nodes: readonly TableNodeType[];
	readonly hiddenIds: ReadonlySet<string>;
	readonly framesApi: FramesApi;
	readonly tablePositions: PositionsApi;
	/** Persiste les tables déplacées par le geste (cf. `useCanvasNodes`). */
	readonly persistMovedTables: () => void;
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
	/** Fin de drag — à passer à `<NestCanvas onNodeDragStop>`. */
	readonly onNodeDragStop: (_: unknown, node: Node) => void;
}

/**
 * Frames imbriqués façon Figma (ADR-034). Le moteur porte la relation
 * parent / enfant : déplacer un frame emmène son contenu, une table poussée
 * contre un bord l'agrandit, le pointeur décide du frame d'arrivée, ce qui
 * dépasse est rogné. Ce hook compose les nodes frame et gère :
 *   - le rect des frames-seed sans rect persisté, figé une fois sur les
 *     positions ELK de leurs membres ;
 *   - renommer / supprimer / focus ;
 *   - la persistance en fin de drag (positions absolues des tables
 *     déplacées, consoles et nodes système à leur position).
 */
export function useCanvasFrames(
	opts: UseCanvasFramesOptions
): UseCanvasFramesReturn {
	const {
		base,
		nodes,
		hiddenIds,
		framesApi,
		tablePositions,
		persistMovedTables,
		history,
		focusFrame
	} = opts;

	const membershipRefreshedFor = useRef<LayoutResult | null>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: framesApi lu via closure — le ref garantit une exécution unique par `base`
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
	}, [base, nodes]);

	// Frames enregistrés avant le rognage : grandis une fois pour contenir
	// leurs membres, qui sinon disparaîtraient rognés.
	useEffect(() => {
		if (nodes.length === 0) return;
		const next = fitLegacyFrames(framesApi.frames, nodes, FRAME_PAD);
		if (next !== framesApi.frames) framesApi.replaceAll(next);
	}, [framesApi, nodes]);

	// Fin de resize d'un frame : le rect a suivi le geste en direct ; ce qui
	// dépasse reste membre (rogné), rien n'est détaché.
	const handleFrameResize = useCallback(
		(_key: string, _rect: FrameRect) => history.push(),
		[history]
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

	const onNodeDragStop = useCallback(
		(_: unknown, node: Node) => {
			const type = (node as { type?: string }).type;
			if (type === "table" || type === "frame") {
				persistMovedTables();
			} else {
				// Consoles et nodes système : toujours à la racine.
				tablePositions.setPosition(node.id, node.position);
			}
			history.push();
		},
		[persistMovedTables, tablePositions, history]
	);

	return {
		frameNodes,
		handleFrameRename,
		handleFrameDelete,
		onNodeDragStop
	};
}
