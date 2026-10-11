import {
	type CSSProperties,
	type MouseEvent as ReactMouseEvent,
	type ReactNode,
	type UIEvent,
	useContext,
	useEffect,
	useState
} from "react";
import { canvasClass } from "../constants";
import { StoreContext, useStoreApi } from "../context";
import { type KeyCode, useKeyPress } from "../keys";
import type { CanvasStore } from "../store";
import type {
	Edge,
	EdgeTypes,
	FitViewOptions,
	Node,
	NodeChange,
	NodeTypes,
	Viewport
} from "../types";
import { isMacOs } from "../wheel";
import {
	DEFAULT_MAX_ZOOM,
	DEFAULT_MIN_ZOOM,
	newStore
} from "./NestCanvasProvider";
import { NodeRenderer } from "./NodeRenderer";
import { Viewport as ViewportLayer } from "./Viewport";
import { Pane, ZoomPane } from "./ZoomPane";

export type NestCanvasProps<
	TNode extends Node = Node,
	TEdge extends Edge = Edge
> = {
	nodes?: TNode[];
	edges?: TEdge[];
	onNodesChange?: (changes: NodeChange<TNode>[]) => void;
	nodeTypes?: NodeTypes;
	edgeTypes?: EdgeTypes;
	defaultViewport?: Viewport;
	minZoom?: number;
	maxZoom?: number;
	/** Accepté pour compatibilité de signature ; le cadrage passe par `fitView()`. */
	fitViewOptions?: FitViewOptions;
	panOnScroll?: boolean;
	panOnScrollSpeed?: number;
	zoomOnScroll?: boolean;
	zoomOnPinch?: boolean;
	zoomOnDoubleClick?: boolean;
	panOnDrag?: boolean | number[];
	selectionOnDrag?: boolean;
	panActivationKeyCode?: KeyCode;
	zoomActivationKeyCode?: KeyCode;
	selectionKeyCode?: KeyCode;
	paneClickDistance?: number;
	onlyRenderVisibleElements?: boolean;
	elevateNodesOnSelect?: boolean;
	onPaneClick?: (event: ReactMouseEvent) => void;
	onPaneContextMenu?: (event: ReactMouseEvent) => void;
	className?: string;
	style?: CSSProperties;
	id?: string;
	children?: ReactNode;
};

const wrapperStyle: CSSProperties = {
	width: "100%",
	height: "100%",
	overflow: "hidden",
	position: "relative",
	zIndex: 0
};

const DEFAULT_VIEWPORT: Viewport = { x: 0, y: 0, zoom: 1 };

/** Recopie les props dans le store après rendu. */
function StoreUpdater({
	nodes,
	edges,
	onNodesChange,
	minZoom,
	maxZoom,
	elevateNodesOnSelect
}: {
	nodes: Node[] | undefined;
	edges: Edge[] | undefined;
	onNodesChange: ((changes: NodeChange[]) => void) | undefined;
	minZoom: number;
	maxZoom: number;
	elevateNodesOnSelect: boolean;
}) {
	const store = useStoreApi();
	useEffect(() => {
		store.setState({
			minZoom,
			maxZoom,
			elevateNodesOnSelect,
			onNodesChange: onNodesChange ?? null
		});
	}, [store, minZoom, maxZoom, elevateNodesOnSelect, onNodesChange]);
	useEffect(() => {
		if (nodes !== undefined) store.setNodes(nodes);
	}, [store, nodes]);
	useEffect(() => {
		if (edges !== undefined) store.setEdges(edges);
	}, [store, edges]);
	return null;
}

function GraphView(
	props: NestCanvasProps & { minZoom: number; maxZoom: number }
) {
	const {
		nodeTypes,
		defaultViewport = DEFAULT_VIEWPORT,
		panOnScroll = false,
		panOnScrollSpeed = 0.5,
		zoomOnScroll = true,
		zoomOnPinch = true,
		zoomOnDoubleClick = true,
		panOnDrag: panOnDragProp = true,
		selectionOnDrag = false,
		panActivationKeyCode = "Space",
		zoomActivationKeyCode = isMacOs() ? "Meta" : "Control",
		selectionKeyCode = "Shift",
		paneClickDistance = 1,
		onlyRenderVisibleElements = false,
		onPaneClick,
		onPaneContextMenu
	} = props;

	const selectionKeyPressed = useKeyPress(selectionKeyCode, {
		target: "window"
	});
	const panKeyPressed = useKeyPress(panActivationKeyCode, { target: "window" });
	const zoomKeyPressed = useKeyPress(zoomActivationKeyCode);

	const panOnDrag = panKeyPressed || panOnDragProp;
	const effectivePanOnScroll = panKeyPressed || panOnScroll;
	const effectiveSelectionOnDrag = selectionOnDrag && panOnDrag !== true;
	const isSelecting = selectionKeyPressed || effectiveSelectionOnDrag;

	return (
		<ZoomPane
			defaultViewport={defaultViewport}
			minZoom={props.minZoom}
			maxZoom={props.maxZoom}
			panOnScroll={effectivePanOnScroll}
			panOnScrollSpeed={panOnScrollSpeed}
			zoomOnScroll={zoomOnScroll}
			zoomOnPinch={zoomOnPinch}
			zoomOnDoubleClick={zoomOnDoubleClick}
			panOnDrag={!selectionKeyPressed && panOnDrag}
			zoomActivationKeyPressed={zoomKeyPressed}
			selectionOnDrag={effectiveSelectionOnDrag}
			paneClickDistance={paneClickDistance}
		>
			<Pane
				panOnDrag={panOnDrag}
				isSelecting={isSelecting}
				onPaneClick={onPaneClick}
				onPaneContextMenu={onPaneContextMenu}
			>
				<ViewportLayer>
					<div className={canvasClass.edgeLabelRenderer} />
					<NodeRenderer
						nodeTypes={nodeTypes}
						onlyRenderVisibleElements={onlyRenderVisibleElements}
					/>
					<div className={canvasClass.viewportPortal} />
				</ViewportLayer>
			</Pane>
		</ZoomPane>
	);
}

/** Canvas infini : viewport pan/zoom, nodes React positionnés, edges SVG. */
export function NestCanvas<
	TNode extends Node = Node,
	TEdge extends Edge = Edge
>(props: NestCanvasProps<TNode, TEdge>) {
	const {
		nodes,
		edges,
		onNodesChange,
		minZoom = DEFAULT_MIN_ZOOM,
		maxZoom = DEFAULT_MAX_ZOOM,
		elevateNodesOnSelect = true,
		className,
		style,
		id,
		children
	} = props;
	const outer = useContext(StoreContext);
	const [own] = useState<CanvasStore | null>(() =>
		outer === null ? newStore(minZoom, maxZoom) : null
	);
	const store = outer ?? (own as CanvasStore);

	// Le défilement natif du wrapper (focus d'un node hors écran) décalerait
	// tout le canvas : on le remet à zéro.
	const onScroll = (event: UIEvent<HTMLDivElement>) => {
		event.currentTarget.scrollTo({ top: 0, left: 0, behavior: "instant" });
	};

	return (
		<div
			className={[canvasClass.root, className].filter(Boolean).join(" ")}
			style={{ ...style, ...wrapperStyle }}
			id={id}
			role="application"
			onScroll={onScroll}
		>
			<StoreContext.Provider value={store}>
				<StoreUpdater
					nodes={nodes as Node[] | undefined}
					edges={edges as Edge[] | undefined}
					onNodesChange={
						onNodesChange as ((changes: NodeChange[]) => void) | undefined
					}
					minZoom={minZoom}
					maxZoom={maxZoom}
					elevateNodesOnSelect={elevateNodesOnSelect}
				/>
				<GraphView
					{...(props as unknown as NestCanvasProps)}
					minZoom={minZoom}
					maxZoom={maxZoom}
				/>
				{children}
			</StoreContext.Provider>
		</div>
	);
}
