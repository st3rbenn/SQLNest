import {
	type CSSProperties,
	memo,
	useCallback,
	useEffect,
	useRef
} from "react";
import { canvasClass } from "../constants";
import { useNestStore, useNodeId, useStoreApi } from "../context";
import { NO_DRAG_CLASS } from "../drag";
import {
	type ControlPosition,
	createResizer,
	type ResizeCallbacks,
	type ResizerOptions
} from "../resizer";
import type { CanvasState } from "../store";

type Variant = "line" | "handle";

const LINE_POSITIONS: ControlPosition[] = ["top", "right", "bottom", "left"];
const HANDLE_POSITIONS: ControlPosition[] = [
	"top-left",
	"top-right",
	"bottom-left",
	"bottom-right"
];

export type ResizeControlProps = ResizeCallbacks & {
	nodeId?: string;
	position?: ControlPosition;
	variant?: Variant;
	className?: string | undefined;
	style?: CSSProperties | undefined;
	color?: string | undefined;
	minWidth?: number;
	minHeight?: number;
	maxWidth?: number;
	maxHeight?: number;
	/** Les poignées gardent leur taille à l'écran quand on dézoome. */
	autoScale?: boolean;
};

function ResizeControlComponent({
	nodeId,
	position,
	variant = "handle",
	className,
	style,
	color,
	minWidth = 10,
	minHeight = 10,
	maxWidth = Number.MAX_VALUE,
	maxHeight = Number.MAX_VALUE,
	autoScale = true,
	onResizeStart,
	onResize,
	onResizeEnd,
	shouldResize
}: ResizeControlProps) {
	const contextNodeId = useNodeId();
	const id = nodeId ?? contextNodeId;
	const store = useStoreApi();
	const ref = useRef<HTMLDivElement>(null);
	const isHandle = variant === "handle";
	const controlPosition = position ?? (isHandle ? "bottom-right" : "right");
	const scale = useNestStore(
		useCallback(
			(s: CanvasState) =>
				isHandle && autoScale
					? `${Math.max(1 / s.transform[2], 1)}`
					: undefined,
			[isHandle, autoScale]
		)
	);
	const options = useRef<ResizerOptions | null>(null);
	options.current =
		id === null
			? null
			: {
					nodeId: id,
					position: controlPosition,
					boundaries: { minWidth, minHeight, maxWidth, maxHeight },
					onResizeStart,
					onResize,
					onResizeEnd,
					shouldResize
				};

	useEffect(() => {
		const el = ref.current;
		if (el === null || id === null) return;
		return createResizer(el, store, () => options.current as ResizerOptions);
	}, [id, store]);

	return (
		<div
			ref={ref}
			className={[
				canvasClass.resizeControl,
				NO_DRAG_CLASS,
				...controlPosition.split("-"),
				variant,
				className
			]
				.filter(Boolean)
				.join(" ")}
			style={{
				...style,
				...(scale !== undefined ? { scale } : {}),
				...(color
					? { [isHandle ? "backgroundColor" : "borderColor"]: color }
					: {})
			}}
		/>
	);
}

export const NodeResizeControl = memo(ResizeControlComponent);

export type NodeResizerProps = ResizeCallbacks & {
	nodeId?: string;
	isVisible?: boolean;
	handleClassName?: string;
	handleStyle?: CSSProperties;
	lineClassName?: string;
	lineStyle?: CSSProperties;
	color?: string;
	minWidth?: number;
	minHeight?: number;
	maxWidth?: number;
	maxHeight?: number;
	autoScale?: boolean;
};

/** Quatre bords + quatre coins de redimensionnement autour du node courant. */
export function NodeResizer({
	isVisible = true,
	handleClassName,
	handleStyle,
	lineClassName,
	lineStyle,
	...shared
}: NodeResizerProps) {
	if (!isVisible) return null;
	return (
		<>
			{LINE_POSITIONS.map((position) => (
				<NodeResizeControl
					key={position}
					className={lineClassName}
					style={lineStyle}
					position={position}
					variant="line"
					{...shared}
				/>
			))}
			{HANDLE_POSITIONS.map((position) => (
				<NodeResizeControl
					key={position}
					className={handleClassName}
					style={handleStyle}
					position={position}
					{...shared}
				/>
			))}
		</>
	);
}
