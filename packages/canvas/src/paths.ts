import { Position } from "./types";

type PathParams = {
	sourceX: number;
	sourceY: number;
	sourcePosition?: Position;
	targetX: number;
	targetY: number;
	targetPosition?: Position;
	curvature?: number;
};

function controlOffset(distance: number, curvature: number): number {
	return distance >= 0 ? 0.5 * distance : curvature * 25 * Math.sqrt(-distance);
}

function controlPoint(
	pos: Position,
	x1: number,
	y1: number,
	x2: number,
	y2: number,
	c: number
): [number, number] {
	switch (pos) {
		case Position.Left:
			return [x1 - controlOffset(x1 - x2, c), y1];
		case Position.Right:
			return [x1 + controlOffset(x2 - x1, c), y1];
		case Position.Top:
			return [x1, y1 - controlOffset(y1 - y2, c)];
		default:
			return [x1, y1 + controlOffset(y2 - y1, c)];
	}
}

/**
 * Courbe de Bézier cubique entre deux points d'accroche, tangentes sortant
 * perpendiculairement au côté de chaque handle. Retourne le chemin SVG, le
 * point milieu (t = 0.5) et son écart au départ.
 */
export function getBezierPath({
	sourceX,
	sourceY,
	sourcePosition = Position.Bottom,
	targetX,
	targetY,
	targetPosition = Position.Top,
	curvature = 0.25
}: PathParams): [string, number, number, number, number] {
	const [scx, scy] = controlPoint(
		sourcePosition,
		sourceX,
		sourceY,
		targetX,
		targetY,
		curvature
	);
	const [tcx, tcy] = controlPoint(
		targetPosition,
		targetX,
		targetY,
		sourceX,
		sourceY,
		curvature
	);
	const labelX = sourceX * 0.125 + scx * 0.375 + tcx * 0.375 + targetX * 0.125;
	const labelY = sourceY * 0.125 + scy * 0.375 + tcy * 0.375 + targetY * 0.125;
	return [
		`M${sourceX},${sourceY} C${scx},${scy} ${tcx},${tcy} ${targetX},${targetY}`,
		labelX,
		labelY,
		Math.abs(labelX - sourceX),
		Math.abs(labelY - sourceY)
	];
}
