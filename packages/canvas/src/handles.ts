import { nodeDimensions } from "./geometry";
import {
	type HandleBound,
	type HandleBounds,
	type HandleType,
	type InternalNode,
	Position,
	type XYPosition
} from "./types";

export const oppositePosition: Record<Position, Position> = {
	[Position.Left]: Position.Right,
	[Position.Right]: Position.Left,
	[Position.Top]: Position.Bottom,
	[Position.Bottom]: Position.Top
};

function measure(
	type: HandleType,
	nodeElement: HTMLElement,
	nodeRect: DOMRect,
	zoom: number,
	nodeId: string
): HandleBound[] | null {
	const elements = nodeElement.querySelectorAll<HTMLElement>(`.${type}`);
	if (elements.length === 0) return null;
	return Array.from(elements).map((el) => {
		const r = el.getBoundingClientRect();
		return {
			id: el.getAttribute("data-handleid"),
			type,
			nodeId,
			position: el.getAttribute("data-handlepos") as Position,
			x: (r.left - nodeRect.left) / zoom,
			y: (r.top - nodeRect.top) / zoom,
			width: el.offsetWidth,
			height: el.offsetHeight
		};
	});
}

/** Handles d'un node, relatifs à son coin, en unités flow. */
export function measureHandleBounds(
	nodeElement: HTMLElement,
	zoom: number,
	nodeId: string
): HandleBounds {
	const rect = nodeElement.getBoundingClientRect();
	return {
		source: measure("source", nodeElement, rect, zoom, nodeId),
		target: measure("target", nodeElement, rect, zoom, nodeId)
	};
}

/**
 * Point d'accroche d'un handle en coordonnées flow : milieu du côté indiqué
 * par sa position, ou son centre si `center`.
 */
export function handlePosition(
	node: InternalNode,
	handle: HandleBound | null,
	fallback: Position = Position.Left,
	center = false
): XYPosition {
	const x = (handle?.x ?? 0) + node.internals.positionAbsolute.x;
	const y = (handle?.y ?? 0) + node.internals.positionAbsolute.y;
	const { width, height } = handle ?? nodeDimensions(node);
	if (center) return { x: x + width / 2, y: y + height / 2 };
	switch (handle?.position ?? fallback) {
		case Position.Top:
			return { x: x + width / 2, y };
		case Position.Right:
			return { x: x + width, y: y + height / 2 };
		case Position.Bottom:
			return { x: x + width / 2, y: y + height };
		default:
			return { x, y: y + height / 2 };
	}
}

/** Handle `handleId` (ou le premier) d'un type donné, position absolue en option. */
export function findHandle(
	node: InternalNode | undefined,
	type: HandleType,
	handleId: string | null,
	withAbsolutePosition = false
): HandleBound | null {
	if (node === undefined) return null;
	const handles = node.internals.handleBounds?.[type];
	const handle =
		(handleId ? handles?.find((h) => h.id === handleId) : handles?.[0]) ?? null;
	return handle && withAbsolutePosition
		? { ...handle, ...handlePosition(node, handle, handle.position, true) }
		: handle;
}

/** Zoom effectif du viewport, transition CSS en cours comprise. */
export function renderedZoom(
	viewportNode: HTMLElement | null,
	fallback: number
): number {
	if (viewportNode === null || typeof window === "undefined") return fallback;
	const transform = window.getComputedStyle(viewportNode).transform;
	if (!transform || transform === "none") return fallback;
	return new DOMMatrixReadOnly(transform).m22 || fallback;
}
