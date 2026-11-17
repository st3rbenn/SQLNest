import {
	canvasClass,
	type EdgeProps,
	getBezierPath,
	type InternalNode,
	Position,
	useNestCanvas
} from "@sqlnest/canvas";
import { bestHandles, type Side } from "../edgeRouting";

export const QUERY_LINK_EDGE = "queryLink";
/** Handle source d'une console vers son résultat. */
export const CONSOLE_RESULT_HANDLE = "result";
/** Handle cible d'un résultat, vers la console ou la table d'où il vient. */
export const RESULT_OWNER_HANDLE = "owner";
/** Handle cible d'une console, vers sa table de départ. */
export const CONSOLE_TABLE_HANDLE = "table";

interface Box {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

function boxOf(node: InternalNode | undefined): Box | null {
	const width = node?.measured.width ?? node?.width;
	const height = node?.measured.height ?? node?.height;
	if (node === undefined || width === undefined || height === undefined) {
		return null;
	}
	return { ...node.internals.positionAbsolute, width, height };
}

function midSide(box: Box, side: Side): { x: number; y: number } {
	if (side === "top") return { x: box.x + box.width / 2, y: box.y };
	if (side === "bottom") {
		return { x: box.x + box.width / 2, y: box.y + box.height };
	}
	if (side === "left") return { x: box.x, y: box.y + box.height / 2 };
	return { x: box.x + box.width, y: box.y + box.height / 2 };
}

const POSITION: Record<Side, Position> = {
	top: Position.Top,
	right: Position.Right,
	bottom: Position.Bottom,
	left: Position.Left
};

/**
 * Lien d'une console vers sa table de départ, ou d'un résultat vers la
 * console (ou la table) d'où il vient. Il part des côtés qui se font face, où que soient posés les deux frames : les
 * handles ne servent qu'à faire exister l'arête pour le moteur.
 */
export function QueryLinkEdge({
	source,
	target,
	sourceX,
	sourceY,
	targetX,
	targetY,
	sourcePosition,
	targetPosition
}: EdgeProps): React.ReactNode {
	const { getInternalNode } = useNestCanvas();
	const from = boxOf(getInternalNode(source));
	const to = boxOf(getInternalNode(target));
	let ends = {
		sourceX,
		sourceY,
		sourcePosition,
		targetX,
		targetY,
		targetPosition
	};
	if (from !== null && to !== null) {
		const sides = bestHandles(from, to);
		const start = midSide(from, sides.source);
		const end = midSide(to, sides.target);
		ends = {
			sourceX: start.x,
			sourceY: start.y,
			sourcePosition: POSITION[sides.source],
			targetX: end.x,
			targetY: end.y,
			targetPosition: POSITION[sides.target]
		};
	}
	const [path] = getBezierPath(ends);
	return (
		<path
			d={path}
			className={canvasClass.edgePath}
			fill="none"
			style={{
				stroke: "var(--sqlnest-accent)",
				strokeWidth: 1.5,
				strokeDasharray: "6 5"
			}}
		/>
	);
}
