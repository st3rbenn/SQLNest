import { calculateNodePosition } from "./parents";
import type { CanvasStore, DragItem } from "./store";

/**
 * Clic (ou Entrée / Espace / Échap) sur un node : sélectionne s'il ne l'est
 * pas ; le retire si `unselect` ou si la multi-sélection est active.
 */
export function handleNodeClick(
	store: CanvasStore,
	id: string,
	options: { unselect?: boolean; element?: HTMLElement | null } = {}
) {
	const { nodeLookup, multiSelectionActive } = store.getState();
	const node = nodeLookup.get(id);
	if (node === undefined) return;
	if (!node.selected) {
		store.addSelectedNodes([id]);
	} else if (options.unselect || multiSelectionActive) {
		store.unselectNodes([node]);
		requestAnimationFrame(() => options.element?.blur());
	}
}

export const ARROW_DIRECTIONS: Record<string, { x: number; y: number }> = {
	ArrowUp: { x: 0, y: -1 },
	ArrowDown: { x: 0, y: 1 },
	ArrowLeft: { x: -1, y: 0 },
	ArrowRight: { x: 1, y: 0 }
};

const ARROW_STEP = 5;

/** Déplace les nodes sélectionnés et déplaçables de 5 px × `factor`. */
export function moveSelectedNodes(
	store: CanvasStore,
	direction: { x: number; y: number },
	factor: number
) {
	const items: DragItem[] = [];
	const dx = direction.x * ARROW_STEP * factor;
	const dy = direction.y * ARROW_STEP * factor;
	const { nodeLookup } = store.getState();
	for (const node of nodeLookup.values()) {
		if (!node.selected || node.draggable === false) continue;
		const { position, positionAbsolute } = calculateNodePosition(
			node,
			{
				x: node.internals.positionAbsolute.x + dx,
				y: node.internals.positionAbsolute.y + dy
			},
			nodeLookup
		);
		node.position = position;
		node.internals.positionAbsolute = positionAbsolute;
		items.push({
			id: node.id,
			position,
			positionAbsolute,
			distance: { x: 0, y: 0 }
		});
	}
	store.updateNodePositions(items, false);
}
