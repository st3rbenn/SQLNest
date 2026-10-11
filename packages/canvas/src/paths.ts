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

/** Milieu d'un segment et demi-écarts en x / y (label des edges droits et step simples). */
export function getEdgeCenter({
	sourceX,
	sourceY,
	targetX,
	targetY
}: {
	sourceX: number;
	sourceY: number;
	targetX: number;
	targetY: number;
}): [number, number, number, number] {
	const xOffset = Math.abs(targetX - sourceX) / 2;
	const centerX = targetX < sourceX ? targetX + xOffset : targetX - xOffset;
	const yOffset = Math.abs(targetY - sourceY) / 2;
	const centerY = targetY < sourceY ? targetY + yOffset : targetY - yOffset;
	return [centerX, centerY, xOffset, yOffset];
}

type Point = { x: number; y: number };
type Axis = "x" | "y";

const handleDirections: Record<Position, Point> = {
	[Position.Left]: { x: -1, y: 0 },
	[Position.Right]: { x: 1, y: 0 },
	[Position.Top]: { x: 0, y: -1 },
	[Position.Bottom]: { x: 0, y: 1 }
};

function getDirection(
	source: Point,
	sourcePosition: Position,
	target: Point
): Point {
	if (sourcePosition === Position.Left || sourcePosition === Position.Right) {
		return source.x < target.x ? { x: 1, y: 0 } : { x: -1, y: 0 };
	}
	return source.y < target.y ? { x: 0, y: 1 } : { x: 0, y: -1 };
}

const distance = (a: Point, b: Point) =>
	Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2);

/**
 * Points d'un tracé orthogonal entre deux handles : on s'écarte de `offset`
 * dans la direction de chaque handle puis on relie par un ou deux coudes.
 * Le label se place au milieu du plus long segment.
 */
function getPoints({
	source,
	sourcePosition,
	target,
	targetPosition,
	center,
	offset,
	stepPosition
}: {
	source: Point;
	sourcePosition: Position;
	target: Point;
	targetPosition: Position;
	center: { x: number | undefined; y: number | undefined };
	offset: number;
	stepPosition: number;
}): [Point[], number, number, number, number] {
	const sourceDir = handleDirections[sourcePosition];
	const targetDir = handleDirections[targetPosition];
	const sourceGapped = {
		x: source.x + sourceDir.x * offset,
		y: source.y + sourceDir.y * offset
	};
	const targetGapped = {
		x: target.x + targetDir.x * offset,
		y: target.y + targetDir.y * offset
	};
	const dir = getDirection(sourceGapped, sourcePosition, targetGapped);
	const axis: Axis = dir.x !== 0 ? "x" : "y";
	const currDir = dir[axis];
	let points: Point[];
	let centerX: number;
	let centerY: number;
	const sourceGapOffset = { x: 0, y: 0 };
	const targetGapOffset = { x: 0, y: 0 };
	const [, , defaultOffsetX, defaultOffsetY] = getEdgeCenter({
		sourceX: source.x,
		sourceY: source.y,
		targetX: target.x,
		targetY: target.y
	});

	if (sourceDir[axis] * targetDir[axis] === -1) {
		// Handles opposés : un seul palier au milieu (ou à `stepPosition`).
		if (axis === "x") {
			centerX =
				center.x ??
				sourceGapped.x + (targetGapped.x - sourceGapped.x) * stepPosition;
			centerY = center.y ?? (sourceGapped.y + targetGapped.y) / 2;
		} else {
			centerX = center.x ?? (sourceGapped.x + targetGapped.x) / 2;
			centerY =
				center.y ??
				sourceGapped.y + (targetGapped.y - sourceGapped.y) * stepPosition;
		}
		const verticalSplit = [
			{ x: centerX, y: sourceGapped.y },
			{ x: centerX, y: targetGapped.y }
		];
		const horizontalSplit = [
			{ x: sourceGapped.x, y: centerY },
			{ x: targetGapped.x, y: centerY }
		];
		if (sourceDir[axis] === currDir) {
			points = axis === "x" ? verticalSplit : horizontalSplit;
		} else {
			points = axis === "x" ? horizontalSplit : verticalSplit;
		}
	} else {
		const sourceTarget = [{ x: sourceGapped.x, y: targetGapped.y }];
		const targetSource = [{ x: targetGapped.x, y: sourceGapped.y }];
		if (axis === "x") {
			points = sourceDir.x === currDir ? targetSource : sourceTarget;
		} else {
			points = sourceDir.y === currDir ? sourceTarget : targetSource;
		}

		if (sourcePosition === targetPosition) {
			// Même côté et handles plus proches que `offset` : sans décalage le
			// coin ajouté se superpose au point écarté.
			const diff = Math.abs(source[axis] - target[axis]);
			if (diff <= offset) {
				const gapOffset = Math.min(offset - 1, offset - diff);
				if (sourceDir[axis] === currDir) {
					sourceGapOffset[axis] =
						(sourceGapped[axis] > source[axis] ? -1 : 1) * gapOffset;
				} else {
					targetGapOffset[axis] =
						(targetGapped[axis] > target[axis] ? -1 : 1) * gapOffset;
				}
			}
		}

		if (sourcePosition !== targetPosition) {
			const opposite: Axis = axis === "x" ? "y" : "x";
			const isSameDir = sourceDir[axis] === targetDir[opposite];
			const sourceGtTargetOppo =
				sourceGapped[opposite] > targetGapped[opposite];
			const sourceLtTargetOppo =
				sourceGapped[opposite] < targetGapped[opposite];
			const flipSourceTarget =
				(sourceDir[axis] === 1 &&
					((!isSameDir && sourceGtTargetOppo) ||
						(isSameDir && sourceLtTargetOppo))) ||
				(sourceDir[axis] !== 1 &&
					((!isSameDir && sourceLtTargetOppo) ||
						(isSameDir && sourceGtTargetOppo)));
			if (flipSourceTarget) {
				points = axis === "x" ? sourceTarget : targetSource;
			}
		}

		const corner = points[0] as Point;
		const sourceGapPoint = {
			x: sourceGapped.x + sourceGapOffset.x,
			y: sourceGapped.y + sourceGapOffset.y
		};
		const targetGapPoint = {
			x: targetGapped.x + targetGapOffset.x,
			y: targetGapped.y + targetGapOffset.y
		};
		const maxXDistance = Math.max(
			Math.abs(sourceGapPoint.x - corner.x),
			Math.abs(targetGapPoint.x - corner.x)
		);
		const maxYDistance = Math.max(
			Math.abs(sourceGapPoint.y - corner.y),
			Math.abs(targetGapPoint.y - corner.y)
		);
		if (maxXDistance >= maxYDistance) {
			centerX = (sourceGapPoint.x + targetGapPoint.x) / 2;
			centerY = corner.y;
		} else {
			centerX = corner.x;
			centerY = (sourceGapPoint.y + targetGapPoint.y) / 2;
		}
	}

	const gappedSource = {
		x: sourceGapped.x + sourceGapOffset.x,
		y: sourceGapped.y + sourceGapOffset.y
	};
	const gappedTarget = {
		x: targetGapped.x + targetGapOffset.x,
		y: targetGapped.y + targetGapOffset.y
	};
	const first = points[0] as Point;
	const last = points[points.length - 1] as Point;
	// Un point écarté confondu avec le coin voisin fausserait l'arrondi.
	const pathPoints = [
		source,
		...(gappedSource.x !== first.x || gappedSource.y !== first.y
			? [gappedSource]
			: []),
		...points,
		...(gappedTarget.x !== last.x || gappedTarget.y !== last.y
			? [gappedTarget]
			: []),
		target
	];
	return [pathPoints, centerX, centerY, defaultOffsetX, defaultOffsetY];
}

function getBend(a: Point, b: Point, c: Point, size: number): string {
	const bendSize = Math.min(distance(a, b) / 2, distance(b, c) / 2, size);
	const { x, y } = b;
	if ((a.x === x && x === c.x) || (a.y === y && y === c.y)) {
		return `L${x} ${y}`;
	}
	if (a.y === y) {
		const xDir = a.x < c.x ? -1 : 1;
		const yDir = a.y < c.y ? 1 : -1;
		return `L ${x + bendSize * xDir},${y}Q ${x},${y} ${x},${y + bendSize * yDir}`;
	}
	const xDir = a.x < c.x ? 1 : -1;
	const yDir = a.y < c.y ? -1 : 1;
	return `L ${x},${y + bendSize * yDir}Q ${x},${y} ${x + bendSize * xDir},${y}`;
}

/**
 * Tracé orthogonal à coins arrondis entre deux handles. Retourne le chemin
 * SVG, la position du label et son écart au départ.
 */
export function getSmoothStepPath({
	sourceX,
	sourceY,
	sourcePosition = Position.Bottom,
	targetX,
	targetY,
	targetPosition = Position.Top,
	borderRadius = 5,
	centerX,
	centerY,
	offset = 20,
	stepPosition = 0.5
}: {
	sourceX: number;
	sourceY: number;
	sourcePosition?: Position;
	targetX: number;
	targetY: number;
	targetPosition?: Position;
	borderRadius?: number;
	centerX?: number;
	centerY?: number;
	offset?: number;
	stepPosition?: number;
}): [string, number, number, number, number] {
	const [points, labelX, labelY, offsetX, offsetY] = getPoints({
		source: { x: sourceX, y: sourceY },
		sourcePosition,
		target: { x: targetX, y: targetY },
		targetPosition,
		center: { x: centerX, y: centerY },
		offset,
		stepPosition
	});
	const start = points[0] as Point;
	const end = points[points.length - 1] as Point;
	let path = `M${start.x} ${start.y}`;
	for (let i = 1; i < points.length - 1; i++) {
		path += getBend(
			points[i - 1] as Point,
			points[i] as Point,
			points[i + 1] as Point,
			borderRadius
		);
	}
	path += `L${end.x} ${end.y}`;
	return [path, labelX, labelY, offsetX, offsetY];
}
