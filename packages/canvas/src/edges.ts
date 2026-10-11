import { nodeDimensions, overlappingArea } from "./geometry";
import { handlePosition } from "./handles";
import {
	type Edge,
	type EdgeMarker,
	type HandleBound,
	type InternalNode,
	MarkerType,
	Position,
	type Transform
} from "./types";

export const DEFAULT_MARKER_COLOR = "#b1b1b7";

export type EdgePosition = {
	sourceX: number;
	sourceY: number;
	targetX: number;
	targetY: number;
	sourcePosition: Position;
	targetPosition: Position;
};

function isNodeInitialized(node: InternalNode): boolean {
	return (
		Boolean(node.internals.handleBounds) &&
		Boolean(node.measured.width || node.width || node.initialWidth)
	);
}

function getHandle(
	bounds: HandleBound[],
	handleId: string | null
): HandleBound | null {
	return (
		(!handleId ? bounds[0] : bounds.find((h) => h.id === handleId)) ?? null
	);
}

/**
 * Extrémités d'un edge en coordonnées flow, lues sur les handles mesurés.
 * Sans handle correspondant (node pas encore mesuré, id inconnu) l'edge
 * n'est pas dessiné. Une source se relie à un handle `target` (mode strict).
 */
export function getEdgePosition(
	sourceNode: InternalNode,
	targetNode: InternalNode,
	sourceHandleId: string | null,
	targetHandleId: string | null
): EdgePosition | null {
	if (!isNodeInitialized(sourceNode) || !isNodeInitialized(targetNode)) {
		return null;
	}
	const sourceHandle = getHandle(
		sourceNode.internals.handleBounds?.source ?? [],
		sourceHandleId
	);
	const targetHandle = getHandle(
		targetNode.internals.handleBounds?.target ?? [],
		targetHandleId
	);
	if (!sourceHandle || !targetHandle) return null;
	const sourcePosition = sourceHandle.position || Position.Bottom;
	const targetPosition = targetHandle.position || Position.Top;
	const source = handlePosition(sourceNode, sourceHandle, sourcePosition);
	const target = handlePosition(targetNode, targetHandle, targetPosition);
	return {
		sourceX: source.x,
		sourceY: source.y,
		targetX: target.x,
		targetY: target.y,
		sourcePosition,
		targetPosition
	};
}

/**
 * z-index d'un edge : le sien, remonté au-dessus du parent quand une
 * extrémité est dans un sous-flow (ou sélectionnée avec `elevateOnSelect`).
 */
export function elevatedEdgeZIndex({
	sourceNode,
	targetNode,
	selected = false,
	zIndex = 0,
	elevateOnSelect = false
}: {
	sourceNode: InternalNode;
	targetNode: InternalNode;
	selected?: boolean | undefined;
	zIndex?: number | undefined;
	elevateOnSelect?: boolean;
}): number {
	const edgeZ = elevateOnSelect && selected ? zIndex + 1000 : zIndex;
	const nodeZ = Math.max(
		sourceNode.parentId || (elevateOnSelect && sourceNode.selected)
			? sourceNode.internals.z
			: 0,
		targetNode.parentId || (elevateOnSelect && targetNode.selected)
			? targetNode.internals.z
			: 0
	);
	return edgeZ + nodeZ;
}

/** Vrai si la boîte englobant les deux nodes touche l'écran. */
export function isEdgeVisible({
	sourceNode,
	targetNode,
	width,
	height,
	transform
}: {
	sourceNode: InternalNode;
	targetNode: InternalNode;
	width: number;
	height: number;
	transform: Transform;
}): boolean {
	const s = sourceNode.internals.positionAbsolute;
	const t = targetNode.internals.positionAbsolute;
	const sd = nodeDimensions(sourceNode);
	const td = nodeDimensions(targetNode);
	const x = Math.min(s.x, t.x);
	const y = Math.min(s.y, t.y);
	let x2 = Math.max(s.x + sd.width, t.x + td.width);
	let y2 = Math.max(s.y + sd.height, t.y + td.height);
	if (x === x2) x2 += 1;
	if (y === y2) y2 += 1;
	const [tx, ty, k] = transform;
	return (
		overlappingArea(
			-tx / k,
			-ty / k,
			width / k,
			height / k,
			x,
			y,
			x2 - x,
			y2 - y
		) > 0
	);
}

/** Id SVG d'un marker : clés triées, préfixées par l'instance. */
export function getMarkerId(
	marker: EdgeMarker | string | undefined,
	instanceId?: string
): string {
	if (!marker) return "";
	if (typeof marker === "string") return marker;
	const prefix = instanceId ? `${instanceId}__` : "";
	const record = marker as Record<string, unknown>;
	return `${prefix}${Object.keys(record)
		.sort()
		.map((key) => `${key}=${record[key]}`)
		.join("&")}`;
}

export type MarkerDefinition = EdgeMarker & { id: string; color: string };

/** Markers distincts utilisés par les edges, triés par id. */
export function createMarkerIds(
	edges: Edge[],
	instanceId: string,
	defaultColor: string
): MarkerDefinition[] {
	const ids = new Set<string>();
	const markers: MarkerDefinition[] = [];
	for (const edge of edges) {
		for (const marker of [edge.markerStart, edge.markerEnd]) {
			if (!marker || typeof marker !== "object") continue;
			const id = getMarkerId(marker, instanceId);
			if (ids.has(id)) continue;
			markers.push({ id, color: marker.color || defaultColor, ...marker });
			ids.add(id);
		}
	}
	return markers.sort((a, b) => a.id.localeCompare(b.id));
}

export const isMarkerType = (type: string): type is MarkerType =>
	type === MarkerType.Arrow || type === MarkerType.ArrowClosed;
