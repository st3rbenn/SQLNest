import {
	type CSSProperties,
	type MouseEvent as ReactMouseEvent,
	type ReactNode,
	type PointerEvent as ReactPointerEvent,
	type UIEvent,
	useContext,
	useEffect,
	useState
} from "react";
import { canvasClass } from "../constants";
import { StoreContext, useNestStore, useStoreApi } from "../context";
import { type KeyCode, useKeyPress } from "../keys";
import type { CanvasState, CanvasStore, NodeDragHandler } from "../store";
import {
	type Edge,
	type EdgeTypes,
	type FitViewOptions,
	type Node,
	type NodeChange,
	type NodeMouseHandler,
	type NodeTypes,
	SelectionMode,
	type Viewport
} from "../types";
import { isMacOs } from "../wheel";
import { ConnectionLine } from "./ConnectionLine";
import { EdgeRenderer } from "./EdgeRenderer";
import {
	DEFAULT_MAX_ZOOM,
	DEFAULT_MIN_ZOOM,
	newStore
} from "./NestCanvasProvider";
import { NodeRenderer } from "./NodeRenderer";
import { Pane } from "./Pane";
import { Viewport as ViewportLayer } from "./Viewport";
import { ZoomPane } from "./ZoomPane";

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
	multiSelectionKeyCode?: KeyCode;
	deleteKeyCode?: KeyCode;
	selectionMode?: SelectionMode;
	paneClickDistance?: number;
	onlyRenderVisibleElements?: boolean;
	elevateNodesOnSelect?: boolean;
	onPaneClick?: (event: ReactMouseEvent) => void;
	onPaneContextMenu?: (event: ReactMouseEvent) => void;
	onNodeClick?: NodeMouseHandler<TNode>;
	onNodeDoubleClick?: NodeMouseHandler<TNode>;
	onNodeContextMenu?: NodeMouseHandler<TNode>;
	onNodeDragStart?: (event: MouseEvent, node: TNode, nodes: TNode[]) => void;
	onNodeDrag?: (event: MouseEvent, node: TNode, nodes: TNode[]) => void;
	onNodeDragStop?: (event: MouseEvent, node: TNode, nodes: TNode[]) => void;
	onNodesDelete?: (nodes: TNode[]) => void;
	onSelectionStart?: (event: ReactPointerEvent) => void;
	onSelectionEnd?: (event: ReactPointerEvent) => void;
	/**
	 * Re-parentage pendant un drag : le node peut-il rejoindre `parent`
	 * (`null` : racine) ? Absent = jamais de changement de parent.
	 */
	canReparent?: (node: TNode, parent: TNode | null) => boolean;
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
	id,
	canReparent,
	nodes,
	edges,
	onNodesChange,
	minZoom,
	maxZoom,
	elevateNodesOnSelect,
	onNodeDragStart,
	onNodeDrag,
	onNodeDragStop,
	onNodesDelete
}: {
	id: string | undefined;
	canReparent: ((node: Node, parent: Node | null) => boolean) | undefined;
	nodes: Node[] | undefined;
	edges: Edge[] | undefined;
	onNodesChange: ((changes: NodeChange[]) => void) | undefined;
	minZoom: number;
	maxZoom: number;
	elevateNodesOnSelect: boolean;
	onNodeDragStart: NodeDragHandler | undefined;
	onNodeDrag: NodeDragHandler | undefined;
	onNodeDragStop: NodeDragHandler | undefined;
	onNodesDelete: ((nodes: Node[]) => void) | undefined;
}) {
	const store = useStoreApi();
	useEffect(() => {
		store.setState({ instanceId: id || "1" });
	}, [store, id]);
	useEffect(() => {
		store.setState({ canReparent: canReparent ?? null });
	}, [store, canReparent]);
	useEffect(() => {
		store.setState({
			minZoom,
			maxZoom,
			elevateNodesOnSelect,
			onNodesChange: onNodesChange ?? null
		});
	}, [store, minZoom, maxZoom, elevateNodesOnSelect, onNodesChange]);
	useEffect(() => {
		store.setState({
			onNodeDragStart: onNodeDragStart ?? null,
			onNodeDrag: onNodeDrag ?? null,
			onNodeDragStop: onNodeDragStop ?? null,
			onNodesDelete: onNodesDelete ?? null
		});
	}, [store, onNodeDragStart, onNodeDrag, onNodeDragStop, onNodesDelete]);
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
		edgeTypes,
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
		selectionMode = SelectionMode.Full,
		multiSelectionKeyCode = isMacOs() ? "Meta" : "Control",
		deleteKeyCode = "Backspace",
		onPaneClick,
		onPaneContextMenu,
		onNodeClick,
		onNodeDoubleClick,
		onNodeContextMenu,
		onSelectionStart,
		onSelectionEnd
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
	useGlobalKeys(deleteKeyCode, multiSelectionKeyCode);

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
				selectionKeyPressed={selectionKeyPressed}
				selectionOnDrag={effectiveSelectionOnDrag}
				selectionMode={selectionMode}
				paneClickDistance={paneClickDistance}
				onSelectionStart={onSelectionStart}
				onSelectionEnd={onSelectionEnd}
				onPaneClick={onPaneClick}
				onPaneContextMenu={onPaneContextMenu}
			>
				<ViewportLayer>
					<EdgeRenderer
						edgeTypes={edgeTypes}
						onlyRenderVisibleElements={onlyRenderVisibleElements}
					/>
					<ConnectionLine />
					<div className={canvasClass.edgeLabelRenderer} />
					<NodeRenderer
						nodeTypes={nodeTypes}
						onlyRenderVisibleElements={onlyRenderVisibleElements}
						onNodeClick={onNodeClick}
						onNodeDoubleClick={onNodeDoubleClick}
						onNodeContextMenu={onNodeContextMenu}
					/>
					<div className={canvasClass.viewportPortal} />
				</ViewportLayer>
			</Pane>
		</ZoomPane>
	);
}

/** Suppression (Backspace) et multi-sélection (Shift / Cmd / Ctrl). */
function useGlobalKeys(deleteKeyCode: KeyCode, multiSelectionKeyCode: KeyCode) {
	const store = useStoreApi();
	const deletePressed = useKeyPress(deleteKeyCode, {
		actInsideInputWithModifier: false
	});
	const multiPressed = useKeyPress(multiSelectionKeyCode, { target: "window" });
	useEffect(() => {
		if (deletePressed) store.deleteSelectedNodes();
	}, [deletePressed, store]);
	useEffect(() => {
		store.setState({ multiSelectionActive: multiPressed });
	}, [multiPressed, store]);
}

const selectedNodes = (s: CanvasState): Node[] => {
	const nodes: Node[] = [];
	for (const node of s.nodeLookup.values()) {
		if (node.selected) nodes.push(node.internals.userNode);
	}
	return nodes;
};
const sameIds = (a: Node[], b: Node[]) =>
	a.length === b.length && a.every((n, i) => n.id === b[i]?.id);

/** Notifie les abonnés de `useOnSelectionChange` quand l'ensemble sélectionné change. */
function SelectionListener() {
	const store = useStoreApi();
	const nodes = useNestStore(selectedNodes, sameIds);
	useEffect(() => {
		const params = { nodes, edges: [] };
		for (const fn of store.getState().onSelectionChangeHandlers) fn(params);
	}, [nodes, store]);
	return null;
}

const hiddenStyle: CSSProperties = { display: "none" };
const liveStyle: CSSProperties = {
	position: "absolute",
	width: 1,
	height: 1,
	margin: -1,
	border: 0,
	padding: 0,
	overflow: "hidden",
	clip: "rect(0px, 0px, 0px, 0px)",
	clipPath: "inset(100%)"
};

function A11yDescriptions() {
	const { instanceId, message } = useNestStore(
		(s) => ({ instanceId: s.instanceId, message: s.ariaLiveMessage }),
		(a, b) => a.instanceId === b.instanceId && a.message === b.message
	);
	return (
		<>
			<div id={`nest-node-desc-${instanceId}`} style={hiddenStyle}>
				Entrée ou Espace pour sélectionner un node, flèches pour le déplacer,
				Retour arrière pour le supprimer, Échap pour annuler.
			</div>
			<div id={`nest-edge-desc-${instanceId}`} style={hiddenStyle}>
				Entrée ou Espace pour sélectionner un edge, Retour arrière pour le
				supprimer, Échap pour annuler.
			</div>
			<div aria-live="assertive" aria-atomic="true" style={liveStyle}>
				{message}
			</div>
		</>
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
		onNodeDragStart,
		onNodeDrag,
		onNodeDragStop,
		onNodesDelete,
		canReparent,
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
					id={id}
					canReparent={
						canReparent as
							| ((node: Node, parent: Node | null) => boolean)
							| undefined
					}
					nodes={nodes as Node[] | undefined}
					edges={edges as Edge[] | undefined}
					onNodesChange={
						onNodesChange as ((changes: NodeChange[]) => void) | undefined
					}
					minZoom={minZoom}
					maxZoom={maxZoom}
					elevateNodesOnSelect={elevateNodesOnSelect}
					onNodeDragStart={onNodeDragStart as NodeDragHandler | undefined}
					onNodeDrag={onNodeDrag as NodeDragHandler | undefined}
					onNodeDragStop={onNodeDragStop as NodeDragHandler | undefined}
					onNodesDelete={onNodesDelete as ((nodes: Node[]) => void) | undefined}
				/>
				<GraphView
					{...(props as unknown as NestCanvasProps)}
					minZoom={minZoom}
					maxZoom={maxZoom}
				/>
				<SelectionListener />
				{children}
				<A11yDescriptions />
			</StoreContext.Provider>
		</div>
	);
}
