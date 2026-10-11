import {
	type CSSProperties,
	memo,
	type KeyboardEvent as ReactKeyboardEvent,
	type MouseEvent as ReactMouseEvent,
	useCallback,
	useEffect,
	useRef,
	useState
} from "react";
import { canvasClass } from "../constants";
import { NodeIdContext, shallow, useNestStore, useStoreApi } from "../context";
import { createNodeDrag } from "../drag";
import { getNodesInside, hasDimensions, nodeDimensions } from "../geometry";
import { isInputEvent } from "../keys";
import { NO_PAN_CLASS } from "../panZoom";
import {
	ARROW_DIRECTIONS,
	handleNodeClick,
	moveSelectedNodes
} from "../selection";
import { type CanvasState, visibleNodeIds } from "../store";
import type { InternalNode, NodeMouseHandler, NodeTypes } from "../types";

/**
 * Rognage hérité des ancêtres `clipChildren` : intersection de leurs
 * rectangles, exprimée dans le repère du node (le polygone peut déborder
 * de sa boîte). Rien quand le node tient entièrement dans la zone.
 */
function clipPathFor(
	id: string,
	lookup: Map<string, InternalNode>
): string | undefined {
	const node = lookup.get(id);
	if (node === undefined || !node.parentId) return undefined;
	let left = Number.NEGATIVE_INFINITY;
	let top = Number.NEGATIVE_INFINITY;
	let right = Number.POSITIVE_INFINITY;
	let bottom = Number.POSITIVE_INFINITY;
	let clipped = false;
	let current = lookup.get(node.parentId);
	let guard = 0;
	while (current && guard <= lookup.size) {
		if (current.clipChildren) {
			const { x, y } = current.internals.positionAbsolute;
			const { width, height } = nodeDimensions(current);
			left = Math.max(left, x);
			top = Math.max(top, y);
			right = Math.min(right, x + width);
			bottom = Math.min(bottom, y + height);
			clipped = true;
		}
		current = current.parentId ? lookup.get(current.parentId) : undefined;
		guard += 1;
	}
	if (!clipped) return undefined;
	const { x, y } = node.internals.positionAbsolute;
	const { width, height } = nodeDimensions(node);
	if (x >= left && y >= top && x + width <= right && y + height <= bottom) {
		return undefined;
	}
	const l = left - x;
	const t = top - y;
	const r = Math.max(l, right - x);
	const b = Math.max(t, bottom - y);
	return `polygon(${l}px ${t}px, ${r}px ${t}px, ${r}px ${b}px, ${l}px ${b}px)`;
}

export type NodeRendererProps = {
	nodeTypes: NodeTypes | undefined;
	onlyRenderVisibleElements: boolean;
	onNodeClick: NodeMouseHandler | undefined;
	onNodeDoubleClick: NodeMouseHandler | undefined;
	onNodeContextMenu: NodeMouseHandler | undefined;
};

const SELECTION_KEYS = ["Enter", " ", "Escape"];

const containerStyle: CSSProperties = {
	position: "absolute",
	width: "100%",
	height: "100%",
	top: 0,
	left: 0
};

function NodeRendererComponent({
	nodeTypes,
	onlyRenderVisibleElements,
	onNodeClick,
	onNodeDoubleClick,
	onNodeContextMenu
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
					onClick={onNodeClick}
					onDoubleClick={onNodeDoubleClick}
					onContextMenu={onNodeContextMenu}
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
	onClick: NodeMouseHandler | undefined;
	onDoubleClick: NodeMouseHandler | undefined;
	onContextMenu: NodeMouseHandler | undefined;
};

function NodeWrapperComponent({
	id,
	nodeTypes,
	resizeObserver,
	onClick,
	onDoubleClick,
	onContextMenu
}: NodeWrapperProps) {
	const store = useStoreApi();
	const node = useNestStore((s) => s.nodeLookup.get(id));
	const descriptionId = useNestStore((s) => `nest-node-desc-${s.instanceId}`);
	const clipPath = useNestStore(
		useCallback((s: CanvasState) => clipPathFor(id, s.nodeLookup), [id])
	);
	const isDropTarget = useNestStore((s) => s.dropTargetId === id);
	const ref = useRef<HTMLDivElement>(null);
	const [dragging, setDragging] = useState(false);
	const isDraggable =
		node !== undefined && !node.hidden && node.draggable !== false;
	const isSelectable = node?.selectable !== false;
	const dragParams = useRef({
		nodeId: id,
		isSelectable,
		handleSelector: node?.dragHandle
	});
	dragParams.current = {
		nodeId: id,
		isSelectable,
		handleSelector: node?.dragHandle
	};

	useEffect(() => {
		const el = ref.current;
		if (!isDraggable || el === null) return;
		return createNodeDrag(el, store, () => dragParams.current, {
			onNodeMouseDown: (nodeId) =>
				handleNodeClick(store, nodeId, { element: el }),
			onDragStart: () => setDragging(true),
			onDragStop: () => setDragging(false)
		});
	}, [isDraggable, store]);
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

	// Type ou côté des handles changé par l'app : les handles ont bougé dans
	// le node, on les re-mesure.
	const nodeType = node?.type;
	const sourcePosition = node?.sourcePosition;
	const targetPosition = node?.targetPosition;
	const previousLayout = useRef({ nodeType, sourcePosition, targetPosition });
	useEffect(() => {
		const prev = previousLayout.current;
		if (
			ref.current &&
			(prev.nodeType !== nodeType ||
				prev.sourcePosition !== sourcePosition ||
				prev.targetPosition !== targetPosition)
		) {
			previousLayout.current = { nodeType, sourcePosition, targetPosition };
			store.updateNodeDimensions([ref.current]);
		}
	}, [nodeType, sourcePosition, targetPosition, store]);
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

	const isFocusable = node.focusable !== false;
	const dims = nodeDimensions(node);
	const userNode = node.internals.userNode;
	const classes = [canvasClass.node, `${canvasClass.node}-${type}`];
	if (isDraggable) classes.push(NO_PAN_CLASS);
	if (node.className) classes.push(node.className);
	if (node.selected) classes.push("selected");
	if (isSelectable) classes.push("selectable");
	if (isDraggable) classes.push("draggable");
	if (dragging) classes.push("dragging");
	if (isDropTarget) classes.push("drop-target");

	const onSelect = (event: ReactMouseEvent) => {
		// Le drag sélectionne déjà au démarrage ; le clic sans mouvement passe ici.
		if (isSelectable) handleNodeClick(store, id, { element: ref.current });
		onClick?.(event, { ...userNode });
	};
	const onKeyDown = (event: ReactKeyboardEvent) => {
		if (isInputEvent(event.nativeEvent)) return;
		if (SELECTION_KEYS.includes(event.key) && isSelectable) {
			handleNodeClick(store, id, {
				unselect: event.key === "Escape",
				element: ref.current
			});
			return;
		}
		const direction = ARROW_DIRECTIONS[event.key];
		if (direction !== undefined && isDraggable && node.selected) {
			event.preventDefault();
			const p = node.internals.positionAbsolute;
			store.setState({
				ariaLiveMessage: `Node déplacé vers ${DIRECTION_LABEL[event.key]}. Position x : ${~~p.x}, y : ${~~p.y}`
			});
			moveSelectedNodes(store, direction, event.shiftKey ? 4 : 1);
		}
	};
	// Focus clavier sur un node hors écran : on le recentre sans changer le zoom.
	const onFocus = () => {
		if (!ref.current?.matches(":focus-visible")) return;
		const { transform, width, height, panZoom } = store.getState();
		const visible =
			getNodesInside([node], { x: 0, y: 0, width, height }, transform, true)
				.length > 0;
		if (visible || panZoom === null) return;
		const k = transform[2];
		const { x, y } = node.internals.positionAbsolute;
		panZoom.setViewport({
			x: width / 2 - (x + dims.width / 2) * k,
			y: height / 2 - (y + dims.height / 2) * k,
			zoom: k
		});
	};

	const { x, y } = node.internals.positionAbsolute;
	return (
		// biome-ignore lint/a11y: conteneur de node focusable, rôle porté par `role`
		<div
			ref={ref}
			className={classes.join(" ")}
			style={{
				zIndex: node.internals.z,
				transform: `translate(${x}px,${y}px)`,
				pointerEvents: isSelectable || isDraggable || onClick ? "all" : "none",
				visibility: hasDimensions(node) ? "visible" : "hidden",
				...(clipPath ? { clipPath } : {}),
				...node.style,
				...(inlineDimensions(node) as CSSProperties)
			}}
			data-id={id}
			onClick={onSelect}
			onDoubleClick={
				onDoubleClick ? (e) => onDoubleClick(e, { ...userNode }) : undefined
			}
			onContextMenu={
				onContextMenu ? (e) => onContextMenu(e, { ...userNode }) : undefined
			}
			onKeyDown={isFocusable ? onKeyDown : undefined}
			onFocus={isFocusable ? onFocus : undefined}
			tabIndex={isFocusable ? 0 : undefined}
			role={node.ariaRole ?? (isFocusable ? "group" : undefined)}
			aria-roledescription="node"
			aria-describedby={descriptionId}
			aria-label={node.ariaLabel}
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
					dragging={dragging}
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

const DIRECTION_LABEL: Record<string, string> = {
	ArrowUp: "le haut",
	ArrowDown: "le bas",
	ArrowLeft: "la gauche",
	ArrowRight: "la droite"
};
