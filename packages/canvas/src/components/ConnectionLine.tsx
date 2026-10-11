import { canvasClass } from "../constants";
import { shallow, useNestStore } from "../context";
import { pointToFlow } from "../geometry";
import { getBezierPath } from "../paths";
import type { CanvasState } from "../store";

const selector = (s: CanvasState) => ({
	connection: s.connection,
	transform: s.transform,
	width: s.width,
	height: s.height
});

/** Ligne tracée pendant un drag depuis un handle, en coordonnées flow. */
export function ConnectionLine() {
	const { connection, transform, width, height } = useNestStore(
		selector,
		shallow
	);
	const { inProgress, from, fromPosition, to, toPosition, isValid } =
		connection;
	if (!width || !inProgress || from === null || to === null) return null;
	const target = pointToFlow(to, transform);
	const [path] = getBezierPath({
		sourceX: from.x,
		sourceY: from.y,
		...(fromPosition ? { sourcePosition: fromPosition } : {}),
		targetX: target.x,
		targetY: target.y,
		...(toPosition ? { targetPosition: toPosition } : {})
	});
	const status = isValid === null ? null : isValid ? "valid" : "invalid";
	return (
		<svg
			aria-hidden="true"
			width={width}
			height={height}
			className={`${canvasClass.connectionLine} ${canvasClass.container}`}
		>
			<g className={[canvasClass.connection, status].filter(Boolean).join(" ")}>
				<path d={path} fill="none" className={canvasClass.connectionPath} />
			</g>
		</svg>
	);
}
