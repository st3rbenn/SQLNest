import type { FitViewOptions, Node, NodeMouseHandler } from "@sqlnest/canvas";
import type { ChangeGesture } from "../editor/changeSnql";
import type { TableNodeType } from "../TableNode";
import type { XY } from "../useTablePositions";
import type { CanvasContextMenuState } from "./CanvasContext";

const FRAME_ID_PREFIX = /^frame:/;

const typeOf = (node: Node): string | undefined =>
	(node as { type?: string }).type;

/** Champ de la ligne sous le pointeur, dans une carte de table. */
function fieldAt(event: {
	readonly target: EventTarget | null;
}): string | undefined {
	const row = (event.target as Element | null)?.closest?.("[data-field]");
	return row?.getAttribute("data-field") ?? undefined;
}

const withModifier = (event: {
	readonly shiftKey: boolean;
	readonly metaKey: boolean;
	readonly ctrlKey: boolean;
}): boolean => event.shiftKey || event.metaKey || event.ctrlKey;

export interface UseCanvasNodeEventsOptions {
	readonly fitView: (options?: FitViewOptions) => unknown;
	readonly setFocusId: (id: string | null) => void;
	readonly setFocusFrameKey: (key: string | null) => void;
	readonly focusNode: (id: string) => void;
	readonly focusFrame: (key: string) => void;
	readonly focusAndZoom: (id: string) => void;
	readonly setMenu: (menu: CanvasContextMenuState | null) => void;
	readonly setGesture: (gesture: ChangeGesture | null) => void;
	readonly enterConsoleFocus: (id: string) => void;
	readonly removeConsole: (id: string) => void;
	readonly persistConsolePosition: (id: string, position: XY) => void;
	readonly persistSystemNodePosition: (id: string, position: XY) => void;
	/** Fin de drag d'une table ou d'un frame (`useCanvasFrames`). */
	readonly onFrameDragStop: (event: unknown, node: Node) => void;
}

export interface UseCanvasNodeEventsReturn {
	readonly onNodeClick: NodeMouseHandler<TableNodeType>;
	readonly onNodeDoubleClick: NodeMouseHandler<TableNodeType>;
	readonly onNodeContextMenu: NodeMouseHandler<TableNodeType>;
	readonly onNodeDragStop: (event: unknown, node: TableNodeType) => void;
	readonly onNodesDelete: (deleted: readonly Node[]) => void;
	readonly onPaneClick: () => void;
}

/**
 * Gestes sur les nodes du canvas, selon leur type :
 * - clic : focus (table), détails (frame), recadrage (console). Avec Shift,
 *   Cmd ou Ctrl c'est une sélection multiple : pas de focus, et celui en
 *   cours est levé, sinon son anneau côtoierait le contour de sélection ;
 * - double-clic : renommer la colonne visée, sinon recadrer sur la table ;
 *   plein écran pour une console ;
 * - clic droit : menu de la table ou de la colonne visée ;
 * - fin de drag : chaque famille de node garde sa position.
 */
export function useCanvasNodeEvents({
	fitView,
	setFocusId,
	setFocusFrameKey,
	focusNode,
	focusFrame,
	focusAndZoom,
	setMenu,
	setGesture,
	enterConsoleFocus,
	removeConsole,
	persistConsolePosition,
	persistSystemNodePosition,
	onFrameDragStop
}: UseCanvasNodeEventsOptions): UseCanvasNodeEventsReturn {
	return {
		onNodeClick: (event, node) => {
			const type = typeOf(node);
			if (type === "console") {
				if (withModifier(event)) return;
				fitView({ nodes: [{ id: node.id }], padding: 0.25, duration: 350 });
				return;
			}
			if (withModifier(event)) {
				setFocusId(null);
				setFocusFrameKey(null);
				return;
			}
			if (type === "frame") {
				focusFrame(node.id.replace(FRAME_ID_PREFIX, ""));
				return;
			}
			focusNode(node.id);
		},
		onNodeDoubleClick: (event, node) => {
			const type = typeOf(node);
			if (type === "frame") return;
			if (type === "console") {
				enterConsoleFocus(node.id);
				return;
			}
			const field = fieldAt(event);
			if (field !== undefined) {
				setGesture({ kind: "rename-column", table: node.id, column: field });
				return;
			}
			focusAndZoom(node.id);
		},
		onNodeContextMenu: (event, node) => {
			const type = typeOf(node);
			if (type === "frame" || type === "console") return;
			event.preventDefault();
			// Focus sans recadrage : la vue ne bouge pas, le menu posé aux
			// coordonnées du clic reste face à la carte.
			focusNode(node.id);
			const field = fieldAt(event);
			setMenu({
				x: event.clientX,
				y: event.clientY,
				tableName: node.id,
				...(field !== undefined ? { field } : {})
			});
		},
		onNodeDragStop: (event, node) => {
			onFrameDragStop(event, node);
			if (typeOf(node) === "console") {
				persistConsolePosition(node.id, node.position);
			}
			persistSystemNodePosition(node.id, node.position);
		},
		onNodesDelete: (deleted) => {
			// Tables et frames ont leurs propres flux (masquer, sortir du
			// frame) : seules les consoles se suppriment ici.
			for (const node of deleted) {
				if (typeOf(node) === "console") removeConsole(node.id);
			}
		},
		onPaneClick: () => {
			setFocusId(null);
			setMenu(null);
		}
	};
}
