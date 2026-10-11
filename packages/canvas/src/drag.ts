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

/** Point client d'un événement souris, ou du premier doigt posé. */
function clientOf(event: MouseEvent | TouchEvent): {
	clientX: number;
	clientY: number;
} {
	if ("clientX" in event) return event;
	const touch = event.touches[0];
	return {
		clientX: touch?.clientX ?? Number.NaN,
		clientY: touch?.clientY ?? Number.NaN
	};
}

/** Appareil tactile : le drag écoute aussi les doigts. */
export const isTouchable = (element: Element): boolean =>
	(typeof navigator !== "undefined" && navigator.maxTouchPoints > 0) ||
	"ontouchstart" in element;

/** Délai pendant lequel la souris émulée après un toucher est ignorée. */
const TOUCH_ENDING_MS = 500;

/**
 * Drag d'un node (et de toute la sélection avec lui), à la souris ou au
 * doigt. Démarre au-delà de 1 px ; un `mousedown` accepté ne remonte pas
 * (d'où `.nodrag` pour les contrôles internes) et un drag souris qui a bougé
 * avale le clic suivant. Un deuxième doigt posé pendant le geste l'annule.
 */
export function createNodeDrag(
	element: HTMLElement,
	store: CanvasStore,
	getParams: () => NodeDragParams,
	callbacks: NodeDragCallbacks
): () => void {
	let cleanupMouse: (() => void) | null = null;
	let params = getParams();
	// État partagé par les gestes en cours sur ce node (souris ou doigts).
	let active = 0;
	let containerBounds: DOMRect | null = null;
	let dragStarted = false;
	let aborted = false;
	let positionsChanged = false;
	let autoPanStarted = false;
	let autoPanId = 0;
	let dragItems = new Map<string, DragItem>();
	let lastPos: XYPosition = { x: 0, y: 0 };
	let mousePosition: XYPosition = { x: 0, y: 0 };
	let dragEvent: MouseEvent | TouchEvent | null = null;

	const eventPos = (e: MouseEvent | TouchEvent): XYPosition => {
		const { clientX, clientY } = clientOf(e);
		return {
			x: clientX - (containerBounds?.left ?? 0),
			y: clientY - (containerBounds?.top ?? 0)
		};
	};
	const flowPos = (e: MouseEvent | TouchEvent) =>
		pointToFlow(eventPos(e), store.getState().transform);

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
		if (onNodeDrag && dragEvent !== null) {
			const [node, nodes] = handlerParams(true);
			onNodeDrag(dragEvent as MouseEvent, node, nodes);
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

	const startDrag = (e: MouseEvent | TouchEvent) => {
		const s = store.getState();
		dragStarted = true;
		if (!params.isSelectable && !s.multiSelectionActive) {
			if (!s.nodeLookup.get(params.nodeId)?.selected) store.unselectNodes();
		}
		if (params.isSelectable) callbacks.onNodeMouseDown(params.nodeId);
		lastPos = flowPos(e);
		dragItems = new Map();
		for (const [id, node] of store.getState().nodeLookup) {
			if ((node.selected || id === params.nodeId) && node.draggable !== false) {
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
				onNodeDragStart(e as MouseEvent, node, nodes);
			}
		}
	};

	const gestureStart = (e: MouseEvent | TouchEvent) => {
		// Un nouveau geste repart d'un état propre, même après un drag annulé.
		if (active === 0) {
			dragStarted = false;
			autoPanStarted = false;
			cancelAnimationFrame(autoPanId);
			dragItems = new Map();
		}
		active += 1;
		params = getParams();
		containerBounds = store.getState().domNode?.getBoundingClientRect() ?? null;
		aborted = false;
		positionsChanged = false;
		dragEvent = e;
		lastPos = flowPos(e);
		mousePosition = eventPos(e);
	};

	const gestureDrag = (e: MouseEvent | TouchEvent) => {
		const pos = flowPos(e);
		dragEvent = e;
		if (
			(e.type === "touchmove" && (e as TouchEvent).touches.length > 1) ||
			!store.getState().nodeLookup.has(params.nodeId)
		) {
			aborted = true;
		}
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

	const gestureEnd = (e: MouseEvent | TouchEvent) => {
		active = Math.max(0, active - 1);
		if (!dragStarted || aborted) {
			if (aborted) {
				autoPanStarted = false;
				cancelAnimationFrame(autoPanId);
				if (dragItems.size > 0)
					store.updateNodePositions(dragItems.values(), false);
			}
			return;
		}
		autoPanStarted = false;
		dragStarted = false;
		cancelAnimationFrame(autoPanId);
		if (dragItems.size === 0) return;
		if (positionsChanged) {
			store.updateNodePositions(dragItems.values(), false);
			positionsChanged = false;
		}
		callbacks.onDragStop();
		const { onNodeDragStop } = store.getState();
		if (onNodeDragStop) {
			const [node, nodes] = handlerParams(false);
			onNodeDragStop(e as MouseEvent, node, nodes);
		}
	};

	const accepts = (event: MouseEvent | TouchEvent): boolean => {
		const p = getParams();
		if ("button" in event && event.button) return false;
		if (hasSelector(event.target, `.${NO_DRAG_CLASS}`, element)) return false;
		return (
			!p.handleSelector || hasSelector(event.target, p.handleSelector, element)
		);
	};

	let touchending: ReturnType<typeof setTimeout> | null = null;

	const onMouseDown = (down: MouseEvent) => {
		if (touchending !== null || !accepts(down)) return;
		const view = down.view ?? window;
		down.stopImmediatePropagation();
		view.addEventListener("dragstart", swallow, true);
		view.addEventListener("selectstart", swallow, true);
		let moved = false;

		const onMove = (e: MouseEvent) => {
			swallow(e);
			if (!moved) {
				const dx = e.clientX - down.clientX;
				const dy = e.clientY - down.clientY;
				moved = dx * dx + dy * dy > 0;
			}
			gestureDrag(e);
		};
		const end = () => {
			view.removeEventListener("mousemove", onMove, true);
			view.removeEventListener("mouseup", onUp, true);
			view.removeEventListener("dragstart", swallow, true);
			view.removeEventListener("selectstart", swallow, true);
			cleanupMouse = null;
		};
		const onUp = (e: MouseEvent) => {
			end();
			if (moved) {
				view.addEventListener("click", swallow, true);
				setTimeout(() => view.removeEventListener("click", swallow, true), 0);
			}
			swallow(e);
			gestureEnd(e);
		};

		view.addEventListener("mousemove", onMove, true);
		view.addEventListener("mouseup", onUp, true);
		cleanupMouse = () => {
			end();
			cancelAnimationFrame(autoPanId);
		};
		gestureStart(down);
	};

	// Un geste par doigt, identifié par `Touch.identifier`.
	const touches = new Set<number>();
	const onTouchStart = (event: TouchEvent) => {
		if (!accepts(event)) return;
		for (const touch of Array.from(event.changedTouches)) {
			event.stopImmediatePropagation();
			touches.add(touch.identifier);
			gestureStart(event);
		}
	};
	const onTouchMove = (event: TouchEvent) => {
		for (const touch of Array.from(event.changedTouches)) {
			if (!touches.has(touch.identifier)) continue;
			swallow(event);
			gestureDrag(event);
		}
	};
	const onTouchEnd = (event: TouchEvent) => {
		if (touchending !== null) clearTimeout(touchending);
		touchending = setTimeout(() => {
			touchending = null;
		}, TOUCH_ENDING_MS);
		for (const touch of Array.from(event.changedTouches)) {
			if (!touches.delete(touch.identifier)) continue;
			event.stopImmediatePropagation();
			gestureEnd(event);
		}
	};

	element.addEventListener("mousedown", onMouseDown);
	const touchable = isTouchable(element);
	if (touchable) {
		element.addEventListener("touchstart", onTouchStart);
		element.addEventListener("touchmove", onTouchMove, { passive: false });
		element.addEventListener("touchend", onTouchEnd);
		element.addEventListener("touchcancel", onTouchEnd);
		element.style.touchAction = "none";
		element.style.setProperty("-webkit-tap-highlight-color", "rgba(0,0,0,0)");
	}
	return () => {
		cleanupMouse?.();
		if (touchending !== null) clearTimeout(touchending);
		cancelAnimationFrame(autoPanId);
		element.removeEventListener("mousedown", onMouseDown);
		element.removeEventListener("touchstart", onTouchStart);
		element.removeEventListener("touchmove", onTouchMove);
		element.removeEventListener("touchend", onTouchEnd);
		element.removeEventListener("touchcancel", onTouchEnd);
	};
}
