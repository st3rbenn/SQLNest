import { pointToFlow } from "./geometry";
import type { CanvasStore } from "./store";
import type { NodeChange, XYPosition } from "./types";

export type ControlPosition =
	| "top"
	| "right"
	| "bottom"
	| "left"
	| "top-left"
	| "top-right"
	| "bottom-left"
	| "bottom-right";

export type ResizeParams = {
	x: number;
	y: number;
	width: number;
	height: number;
};
export type ResizeParamsWithDirection = ResizeParams & { direction: number[] };

export type ResizeBoundaries = {
	minWidth: number;
	minHeight: number;
	maxWidth: number;
	maxHeight: number;
};

export type ResizeCallbacks = {
	onResizeStart?:
		| ((event: MouseEvent, params: ResizeParams) => void)
		| undefined;
	onResize?:
		| ((event: MouseEvent, params: ResizeParamsWithDirection) => void)
		| undefined;
	onResizeEnd?: ((event: MouseEvent, params: ResizeParams) => void) | undefined;
	shouldResize?:
		| ((event: MouseEvent, params: ResizeParamsWithDirection) => boolean)
		| undefined;
};

type ControlDirection = {
	isHorizontal: boolean;
	isVertical: boolean;
	affectsX: boolean;
	affectsY: boolean;
};

function controlDirection(position: ControlPosition): ControlDirection {
	return {
		isHorizontal: position.includes("right") || position.includes("left"),
		isVertical: position.includes("bottom") || position.includes("top"),
		affectsX: position.includes("left"),
		affectsY: position.includes("top")
	};
}

const sizeClamp = (size: number, min: number, max: number) =>
	Math.max(0, min - size, size - max);

/**
 * Nouvelle géométrie quand le pointeur a bougé de `pointer - start`. Tirer
 * par la gauche (ou le haut) déplace l'origine pour garder le bord opposé
 * fixe ; les bornes min/max rognent le déplacement.
 */
export function dimensionsAfterResize(
	start: ResizeParams & { pointerX: number; pointerY: number },
	direction: ControlDirection,
	pointer: XYPosition,
	b: ResizeBoundaries
): ResizeParams {
	const { affectsX, affectsY, isHorizontal, isVertical } = direction;
	let distX = Math.floor(isHorizontal ? pointer.x - start.pointerX : 0);
	let distY = Math.floor(isVertical ? pointer.y - start.pointerY : 0);
	const newWidth = start.width + (affectsX ? -distX : distX);
	const newHeight = start.height + (affectsY ? -distY : distY);
	const clampX = sizeClamp(newWidth, b.minWidth, b.maxWidth);
	const clampY = sizeClamp(newHeight, b.minHeight, b.maxHeight);
	distY = distY + (distY < 0 ? clampY : -clampY);
	distX = distX + (distX < 0 ? clampX : -clampX);
	return {
		width: start.width + (affectsX ? -distX : distX),
		height: start.height + (affectsY ? -distY : distY),
		x: affectsX ? start.x + distX : start.x,
		y: affectsY ? start.y + distY : start.y
	};
}

function resizeDirection(
	next: ResizeParams,
	prevWidth: number,
	prevHeight: number,
	d: ControlDirection
): number[] {
	const dw = next.width - prevWidth;
	const dh = next.height - prevHeight;
	const dir = [dw > 0 ? 1 : dw < 0 ? -1 : 0, dh > 0 ? 1 : dh < 0 ? -1 : 0];
	if (dw && d.affectsX) dir[0] = (dir[0] as number) * -1;
	if (dh && d.affectsY) dir[1] = (dir[1] as number) * -1;
	return dir;
}

function swallow(event: Event) {
	event.preventDefault();
	event.stopImmediatePropagation();
}

export type ResizerOptions = ResizeCallbacks & {
	nodeId: string;
	position: ControlPosition;
	boundaries: ResizeBoundaries;
};

/**
 * Poignée (ou bord) de redimensionnement d'un node. Émet des changes
 * `position` + `dimensions` (resizing) pendant le geste et un `dimensions`
 * final ; le clic qui suit un geste qui a bougé est avalé.
 */
export function createResizer(
	element: HTMLElement,
	store: CanvasStore,
	getOptions: () => ResizerOptions
): () => void {
	let cleanupGesture: (() => void) | null = null;

	const onMouseDown = (down: MouseEvent) => {
		if (down.ctrlKey || down.button) return;
		const opts = getOptions();
		const { nodeLookup, domNode, transform } = store.getState();
		const node = nodeLookup.get(opts.nodeId);
		if (node === undefined) return;
		const view = down.view ?? window;
		down.stopImmediatePropagation();
		view.addEventListener("dragstart", swallow, true);
		view.addEventListener("selectstart", swallow, true);

		const bounds = domNode?.getBoundingClientRect() ?? null;
		const flowPos = (e: MouseEvent) =>
			pointToFlow(
				{
					x: e.clientX - (bounds?.left ?? 0),
					y: e.clientY - (bounds?.top ?? 0)
				},
				store.getState().transform
			);
		const startPointer = pointToFlow(
			{
				x: down.clientX - (bounds?.left ?? 0),
				y: down.clientY - (bounds?.top ?? 0)
			},
			transform
		);
		const prev: ResizeParams = {
			width: node.measured.width ?? 0,
			height: node.measured.height ?? 0,
			x: node.position.x ?? 0,
			y: node.position.y ?? 0
		};
		const start = {
			...prev,
			pointerX: startPointer.x,
			pointerY: startPointer.y
		};
		let moved = false;
		let resized = false;
		opts.onResizeStart?.(down, { ...prev });

		const onMove = (e: MouseEvent) => {
			swallow(e);
			if (!moved)
				moved = e.clientX !== down.clientX || e.clientY !== down.clientY;
			const o = getOptions();
			const dir = controlDirection(o.position);
			const { width: prevWidth, height: prevHeight, x: prevX, y: prevY } = prev;
			const next = dimensionsAfterResize(start, dir, flowPos(e), o.boundaries);
			const widthChanged = next.width !== prevWidth;
			const heightChanged = next.height !== prevHeight;
			const xChanged = next.x !== prevX && widthChanged;
			const yChanged = next.y !== prevY && heightChanged;
			if (!xChanged && !yChanged && !widthChanged && !heightChanged) return;
			const change: Partial<ResizeParams> = {};
			if (xChanged || yChanged) {
				change.x = xChanged ? next.x : prev.x;
				change.y = yChanged ? next.y : prev.y;
				prev.x = change.x;
				prev.y = change.y;
			}
			if (widthChanged || heightChanged) {
				change.width = widthChanged ? next.width : prev.width;
				change.height = heightChanged ? next.height : prev.height;
				prev.width = change.width;
				prev.height = change.height;
			}
			const withDirection = {
				...prev,
				direction: resizeDirection(prev, prevWidth, prevHeight, dir)
			};
			if (o.shouldResize?.(e, withDirection) === false) return;
			resized = true;
			o.onResize?.(e, withDirection);
			const changes: NodeChange[] = [];
			if (change.x !== undefined && change.y !== undefined) {
				changes.push({
					id: o.nodeId,
					type: "position",
					position: { x: change.x, y: change.y }
				});
			}
			if (change.width !== undefined && change.height !== undefined) {
				changes.push({
					id: o.nodeId,
					type: "dimensions",
					resizing: true,
					setAttributes: true,
					dimensions: { width: change.width, height: change.height }
				});
			}
			store.triggerNodeChanges(changes);
		};

		const end = () => {
			view.removeEventListener("mousemove", onMove, true);
			view.removeEventListener("mouseup", onUp, true);
			view.removeEventListener("dragstart", swallow, true);
			view.removeEventListener("selectstart", swallow, true);
			cleanupGesture = null;
		};

		const onUp = (e: MouseEvent) => {
			end();
			if (moved) {
				view.addEventListener("click", swallow, true);
				setTimeout(() => view.removeEventListener("click", swallow, true), 0);
			}
			swallow(e);
			if (!resized) return;
			const o = getOptions();
			o.onResizeEnd?.(e, { ...prev });
			store.triggerNodeChanges([
				{
					id: o.nodeId,
					type: "dimensions",
					resizing: false,
					dimensions: { width: prev.width, height: prev.height }
				}
			]);
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
