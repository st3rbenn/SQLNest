import type {
	Dimensions,
	InternalNode,
	Node,
	Rect,
	Transform,
	Viewport,
	XYPosition
} from "./types";

export const clamp = (value: number, min = 0, max = 1): number =>
	Math.min(Math.max(value, min), max);

/** Point écran (relatif au conteneur) → coordonnées du flow. */
export const pointToFlow = (
	{ x, y }: XYPosition,
	[tx, ty, k]: Transform
): XYPosition => ({ x: (x - tx) / k, y: (y - ty) / k });

/** Coordonnées du flow → point écran (relatif au conteneur). */
export const flowToPoint = (
	{ x, y }: XYPosition,
	[tx, ty, k]: Transform
): XYPosition => ({ x: x * k + tx, y: y * k + ty });

type Sized = Pick<
	Node,
	"measured" | "width" | "height" | "initialWidth" | "initialHeight"
>;

export function nodeDimensions(node: Sized): Dimensions {
	return {
		width: node.measured?.width ?? node.width ?? node.initialWidth ?? 0,
		height: node.measured?.height ?? node.height ?? node.initialHeight ?? 0
	};
}

export function hasDimensions(node: Sized): boolean {
	return (
		(node.measured?.width ?? node.width ?? node.initialWidth) !== undefined &&
		(node.measured?.height ?? node.height ?? node.initialHeight) !== undefined
	);
}

/** Aire de recouvrement, arrondie au pixel supérieur. */
export function overlappingArea(
	ax: number,
	ay: number,
	aw: number,
	ah: number,
	bx: number,
	by: number,
	bw: number,
	bh: number
): number {
	const xOverlap = Math.max(0, Math.min(ax + aw, bx + bw) - Math.max(ax, bx));
	const yOverlap = Math.max(0, Math.min(ay + ah, by + bh) - Math.max(ay, by));
	return Math.ceil(xOverlap * yOverlap);
}

/**
 * Nodes visibles dans `rect` (coordonnées écran). `partially` : un pixel de
 * recouvrement suffit ; sinon le node doit être entièrement dedans. Un node
 * jamais mesuré est toujours retenu, sinon il ne serait jamais rendu donc
 * jamais mesuré.
 */
export function getNodesInside<T extends InternalNode>(
	nodes: Iterable<T>,
	rect: Rect,
	[tx, ty, k]: Transform,
	partially = false,
	excludeNonSelectable = false
): T[] {
	const paneX = (rect.x - tx) / k;
	const paneY = (rect.y - ty) / k;
	const paneW = rect.width / k;
	const paneH = rect.height / k;
	const visible: T[] = [];
	for (const node of nodes) {
		if ((excludeNonSelectable && node.selectable === false) || node.hidden) {
			continue;
		}
		const width = node.measured.width ?? node.width ?? node.initialWidth ?? 0;
		const height =
			node.measured.height ?? node.height ?? node.initialHeight ?? 0;
		const { x, y } = node.internals.positionAbsolute;
		const overlap = overlappingArea(
			paneX,
			paneY,
			paneW,
			paneH,
			x,
			y,
			width,
			height
		);
		const isVisible =
			node.internals.measuredOnce === undefined ||
			(partially && overlap > 0) ||
			overlap >= width * height;
		if (isVisible || node.dragging) {
			visible.push(node);
		}
	}
	return visible;
}

/** Boîte englobante de nodes internes (vide → rect nul). */
export function internalNodesBounds(nodes: Iterable<InternalNode>): Rect {
	let x = Number.POSITIVE_INFINITY;
	let y = Number.POSITIVE_INFINITY;
	let x2 = Number.NEGATIVE_INFINITY;
	let y2 = Number.NEGATIVE_INFINITY;
	let any = false;
	for (const node of nodes) {
		const { width, height } = nodeDimensions(node);
		const p = node.internals.positionAbsolute;
		x = Math.min(x, p.x);
		y = Math.min(y, p.y);
		x2 = Math.max(x2, p.x + width);
		y2 = Math.max(y2, p.y + height);
		any = true;
	}
	return any
		? { x, y, width: x2 - x, height: y2 - y }
		: { x: 0, y: 0, width: 0, height: 0 };
}

/** Padding relatif (fraction) → pixels, comme le `fitView` historique. */
function paddingPx(padding: number, size: number): number {
	return Math.floor((size - size / (1 + padding)) * 0.5);
}

/** Viewport qui centre `bounds` dans `width × height` avec un padding relatif. */
export function viewportForBounds(
	bounds: Rect,
	width: number,
	height: number,
	minZoom: number,
	maxZoom: number,
	padding: number
): Viewport {
	const px = paddingPx(padding, width);
	const py = paddingPx(padding, height);
	const zoom = Math.min(
		(width - px * 2) / bounds.width,
		(height - py * 2) / bounds.height
	);
	const k = clamp(zoom, minZoom, maxZoom);
	const x = width / 2 - (bounds.x + bounds.width / 2) * k;
	const y = height / 2 - (bounds.y + bounds.height / 2) * k;
	// Padding effectivement obtenu une fois centré : s'il manque d'un côté,
	// on décale pour le respecter (cas où le zoom a été borné).
	const left = Math.floor(bounds.x * k + x);
	const top = Math.floor(bounds.y * k + y);
	const right = Math.floor(width - ((bounds.x + bounds.width) * k + x));
	const bottom = Math.floor(height - ((bounds.y + bounds.height) * k + y));
	return {
		x: x - Math.min(left - px, 0) + Math.min(right - px, 0),
		y: y - Math.min(top - py, 0) + Math.min(bottom - py, 0),
		zoom: k
	};
}

function autoPanVelocity(value: number, min: number, max: number): number {
	if (value < min) return clamp(Math.abs(value - min), 1, min) / min;
	if (value > max) return -clamp(Math.abs(value - max), 1, min) / min;
	return 0;
}

/** Vitesse de pan automatique quand le pointeur approche le bord du conteneur. */
export function autoPan(
	pos: XYPosition,
	bounds: Dimensions,
	speed = 15,
	distance = 40
): [number, number] {
	return [
		autoPanVelocity(pos.x, distance, bounds.width - distance) * speed,
		autoPanVelocity(pos.y, distance, bounds.height - distance) * speed
	];
}
