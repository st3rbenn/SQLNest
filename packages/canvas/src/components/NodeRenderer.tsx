import { type CSSProperties, memo, useEffect, useRef, useState } from "react";
import { canvasClass } from "../constants";
import { NodeIdContext, shallow, useNestStore, useStoreApi } from "../context";
import { hasDimensions, nodeDimensions } from "../geometry";
import { NO_PAN_CLASS } from "../panZoom";
import { type CanvasState, visibleNodeIds } from "../store";
import type { InternalNode, NodeTypes } from "../types";

export type NodeRendererProps = {
	nodeTypes: NodeTypes | undefined;
	onlyRenderVisibleElements: boolean;
};

const containerStyle: CSSProperties = {
	position: "absolute",
	width: "100%",
	height: "100%",
	top: 0,
	left: 0
};

function NodeRendererComponent({
	nodeTypes,
	onlyRenderVisibleElements
}: NodeRendererProps) {
	const ids = useNestStore(
		(s: CanvasState) => visibleNodeIds(s, onlyRenderVisibleElements),
		shallow
	);
	const resizeObserver = useNodeResizeObserver();
	return (
		<div className={canvasClass.nodes} style={containerStyle}>
			{ids.map((id) => (
				<NodeWrapper
					key={id}
					id={id}
					nodeTypes={nodeTypes}
					resizeObserver={resizeObserver}
				/>
			))}
		</div>
	);
}

export const NodeRenderer = memo(NodeRendererComponent);

/** Un seul ResizeObserver pour tous les nodes ; chaque entrée = re-mesure. */
function useNodeResizeObserver(): ResizeObserver | null {
	const store = useStoreApi();
	const [observer] = useState(() =>
		typeof ResizeObserver === "undefined"
			? null
			: new ResizeObserver((entries) => {
					store.updateNodeDimensions(
						entries.map((e) => e.target as HTMLElement)
					);
				})
	);
	useEffect(() => () => observer?.disconnect(), [observer]);
	return observer;
}

function inlineDimensions(node: InternalNode): {
	width?: unknown;
	height?: unknown;
} {
	const style = node.style as { width?: unknown; height?: unknown } | undefined;
	if (node.internals.measuredOnce === undefined) {
		return {
			width: node.width ?? node.initialWidth ?? style?.width,
			height: node.height ?? node.initialHeight ?? style?.height
		};
	}
	return {
		width: node.width ?? style?.width,
		height: node.height ?? style?.height
	};
}

type NodeWrapperProps = {
	id: string;
	nodeTypes: NodeTypes | undefined;
	resizeObserver: ResizeObserver | null;
};

function NodeWrapperComponent({
	id,
	nodeTypes,
	resizeObserver
}: NodeWrapperProps) {
	const node = useNestStore((s) => s.nodeLookup.get(id));
	const ref = useRef<HTMLDivElement>(null);
	const observed = useRef<HTMLDivElement | null>(null);
	const measured =
		node !== undefined &&
		hasDimensions(node) &&
		node.internals.measuredOnce === true;
	const hidden = node?.hidden === true;

	// Observe au montage, et à nouveau quand le node perd sa mesure (node
	// user recréé sans `measured`) : `observe` déclenche une mesure immédiate.
	useEffect(() => {
		if (
			ref.current &&
			!hidden &&
			(!measured || observed.current !== ref.current)
		) {
			if (observed.current) resizeObserver?.unobserve(observed.current);
			resizeObserver?.observe(ref.current);
			observed.current = ref.current;
		}
	}, [measured, hidden, resizeObserver]);
	useEffect(
		() => () => {
			if (observed.current) {
				resizeObserver?.unobserve(observed.current);
				observed.current = null;
			}
		},
		[resizeObserver]
	);

	if (node === undefined || node.hidden) return null;

	const type = node.type ?? "default";
	const NodeComponent = nodeTypes?.[type];
	if (NodeComponent === undefined) return null;

	const isDraggable = node.draggable !== false;
	const isSelectable = node.selectable !== false;
	const dims = nodeDimensions(node);
	const classes = [canvasClass.node, `${canvasClass.node}-${type}`];
	if (isDraggable) classes.push(NO_PAN_CLASS);
	if (node.className) classes.push(node.className);
	if (node.selected) classes.push("selected");
	if (isSelectable) classes.push("selectable");
	if (isDraggable) classes.push("draggable");

	const { x, y } = node.internals.positionAbsolute;
	return (
		<div
			ref={ref}
			className={classes.join(" ")}
			style={{
				zIndex: node.internals.z,
				transform: `translate(${x}px,${y}px)`,
				pointerEvents: isSelectable || isDraggable ? "all" : "none",
				visibility: hasDimensions(node) ? "visible" : "hidden",
				...node.style,
				...(inlineDimensions(node) as CSSProperties)
			}}
			data-id={id}
		>
			<NodeIdContext.Provider value={id}>
				<NodeComponent
					id={id}
					data={node.data}
					type={type}
					positionAbsoluteX={x}
					positionAbsoluteY={y}
					selected={node.selected ?? false}
					selectable={isSelectable}
					draggable={isDraggable}
					deletable={node.deletable ?? true}
					isConnectable
					sourcePosition={node.sourcePosition}
					targetPosition={node.targetPosition}
					dragging={node.dragging ?? false}
					dragHandle={node.dragHandle}
					zIndex={node.internals.z}
					parentId={node.parentId}
					width={dims.width}
					height={dims.height}
				/>
			</NodeIdContext.Provider>
		</div>
	);
}

const NodeWrapper = memo(NodeWrapperComponent);
