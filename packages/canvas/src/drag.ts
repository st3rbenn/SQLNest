import { autoPan, pointToFlow } from "./geometry";
import type { CanvasStore, DragItem } from "./store";
import type { Node, XYPosition } from "./types";

export const NO_DRAG_CLASS = "nodrag";
const NODE_DRAG_THRESHOLD = 1;
const AUTO_PAN_SPEED = 15;

export type NodeDragParams = {
	nodeId: string;
	isSelectable: boolean;
	handleSelector: string | undefined;
};

export type NodeDragCallbacks = {
	/** Sélection au démarrage du drag (même règle qu'un clic). */
	onNodeMouseDown: (id: string) => void;
	onDragStart: () => void;
	onDragStop: () => void;
};

/** Vrai si `target` ou un ancêtre jusqu'à `root` (inclus) matche `selector`. */
function hasSelector(
	target: EventTarget | null,
	selector: string,
	root: Element
): boolean {
	let current = target instanceof Element ? target : null;
	while (current) {
		if (current.matches(selector)) return true;
		if (current === root) return false;
		current = current.parentElement;
	}
	return false;
}

function swallow(event: Event) {
	event.preventDefault();
	event.stopImmediatePropagation();
}

/**
 * Drag d'un node (et de toute la sélection avec lui). Démarre au-delà de
 * 1 px ; un `mousedown` accepté ne remonte pas (d'où `.nodrag` pour les
 * contrôles internes) et un drag qui a bougé avale le clic suivant.
 */
export function createNodeDrag(
	element: HTMLElement,
	store: CanvasStore,
	getParams: () => NodeDragParams,
	callbacks: NodeDragCallbacks
): () => void {
	let cleanupGesture: (() => void) | null = null;

	const onMouseDown = (down: MouseEvent) => {
		const params = getParams();
		if (down.button) return;
		if (hasSelector(down.target, `.${NO_DRAG_CLASS}`, element)) return;
		if (
			params.handleSelector &&
			!hasSelector(down.target, params.handleSelector, element)
		) {
			return;
		}
		const view = down.view ?? window;
		down.stopImmediatePropagation();
		view.addEventListener("dragstart", swallow, true);
		view.addEventListener("selectstart", swallow, true);

		const containerBounds =
			store.getState().domNode?.getBoundingClientRect() ?? null;
		const eventPos = (e: MouseEvent): XYPosition => ({
			x: e.clientX - (containerBounds?.left ?? 0),
			y: e.clientY - (containerBounds?.top ?? 0)
		});
		const flowPos = (e: MouseEvent) =>
			pointToFlow(eventPos(e), store.getState().transform);

		let moved = false;
		let dragStarted = false;
		let aborted = false;
		let positionsChanged = false;
		let autoPanStarted = false;
		let autoPanId = 0;
		let dragItems = new Map<string, DragItem>();
		let lastPos = flowPos(down);
		let mousePosition = eventPos(down);
		let dragEvent = down;

		const handlerParams = (dragging: boolean): [Node, Node[]] => {
			const { nodeLookup } = store.getState();
			const nodes: Node[] = [];
			for (const [id, item] of dragItems) {
				const user = nodeLookup.get(id)?.internals.userNode;
				if (user) nodes.push({ ...user, position: item.position, dragging });
			}
			const user = nodeLookup.get(params.nodeId)?.internals.userNode;
			const current = user
				? {
						...user,
						position: dragItems.get(params.nodeId)?.position ?? user.position,
						dragging
					}
				: (nodes[0] as Node);
			return [current, nodes];
		};

		const updateNodes = (pos: XYPosition) => {
			lastPos = pos;
			const { nodeLookup } = store.getState();
			let changed = false;
			for (const [id, item] of dragItems) {
				if (!nodeLookup.has(id)) continue;
				const next = { x: pos.x - item.distance.x, y: pos.y - item.distance.y };
				changed =
					changed || item.position.x !== next.x || item.position.y !== next.y;
				item.position = next;
			}
			positionsChanged = positionsChanged || changed;
			if (!changed) return;
			store.updateNodePositions(dragItems.values(), true);
			const { onNodeDrag } = store.getState();
			if (onNodeDrag) {
				const [node, nodes] = handlerParams(true);
				onNodeDrag(dragEvent, node, nodes);
			}
		};

		const autoPanLoop = () => {
			if (containerBounds === null) return;
			const [dx, dy] = autoPan(mousePosition, containerBounds, AUTO_PAN_SPEED);
			if (dx !== 0 || dy !== 0) {
				const k = store.getState().transform[2];
				lastPos = { x: lastPos.x - dx / k, y: lastPos.y - dy / k };
				if (store.panBy({ x: dx, y: dy })) updateNodes(lastPos);
			}
			autoPanId = requestAnimationFrame(autoPanLoop);
		};

		const startDrag = (e: MouseEvent) => {
			const s = store.getState();
			dragStarted = true;
			if (!params.isSelectable && !s.multiSelectionActive) {
				if (!s.nodeLookup.get(params.nodeId)?.selected) store.unselectNodes();
			}
			if (params.isSelectable) callbacks.onNodeMouseDown(params.nodeId);
			lastPos = flowPos(e);
			dragItems = new Map();
			for (const [id, node] of store.getState().nodeLookup) {
				if (
					(node.selected || id === params.nodeId) &&
					node.draggable !== false
				) {
					const abs = node.internals.positionAbsolute;
					dragItems.set(id, {
						id,
						position: node.position,
						distance: { x: lastPos.x - abs.x, y: lastPos.y - abs.y }
					});
				}
			}
			if (dragItems.size > 0) {
				callbacks.onDragStart();
				const { onNodeDragStart } = store.getState();
				if (onNodeDragStart) {
					const [node, nodes] = handlerParams(true);
					onNodeDragStart(e, node, nodes);
				}
			}
		};

		const onMove = (e: MouseEvent) => {
			swallow(e);
			if (!moved) {
				const dx = e.clientX - down.clientX;
				const dy = e.clientY - down.clientY;
				moved = dx * dx + dy * dy > 0;
			}
			const pos = flowPos(e);
			dragEvent = e;
			if (!store.getState().nodeLookup.has(params.nodeId)) aborted = true;
			if (aborted) return;
			if (!autoPanStarted && dragStarted) {
				autoPanStarted = true;
				autoPanLoop();
			}
			if (!dragStarted) {
				const p = eventPos(e);
				if (
					Math.hypot(p.x - mousePosition.x, p.y - mousePosition.y) >
					NODE_DRAG_THRESHOLD
				) {
					startDrag(e);
				}
			}
			if ((lastPos.x !== pos.x || lastPos.y !== pos.y) && dragStarted) {
				mousePosition = eventPos(e);
				updateNodes(pos);
			}
		};

		const end = () => {
			view.removeEventListener("mousemove", onMove, true);
			view.removeEventListener("mouseup", onUp, true);
			view.removeEventListener("dragstart", swallow, true);
			view.removeEventListener("selectstart", swallow, true);
			cancelAnimationFrame(autoPanId);
			cleanupGesture = null;
		};

		const onUp = (e: MouseEvent) => {
			end();
			if (moved) {
				view.addEventListener("click", swallow, true);
				setTimeout(() => view.removeEventListener("click", swallow, true), 0);
			}
			swallow(e);
			if (!dragStarted || aborted) {
				if (aborted && dragItems.size > 0)
					store.updateNodePositions(dragItems.values(), false);
				return;
			}
			if (dragItems.size === 0) return;
			if (positionsChanged)
				store.updateNodePositions(dragItems.values(), false);
			callbacks.onDragStop();
			const { onNodeDragStop } = store.getState();
			if (onNodeDragStop) {
				const [node, nodes] = handlerParams(false);
				onNodeDragStop(e, node, nodes);
			}
		};

		view.addEventListener("mousemove", onMove, true);
		view.addEventListener("mouseup", onUp, true);
		cleanupGesture = end;
	};

	element.addEventListener("mousedown", onMouseDown);
	return () => {
		cleanupGesture?.();
		element.removeEventListener("mousedown", onMouseDown);
	};
}
