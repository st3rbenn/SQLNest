import {
	getNodesInside,
	hasDimensions,
	internalNodesBounds,
	viewportForBounds
} from "./geometry";
import type { PanZoom } from "./panZoom";
import type {
	Edge,
	FitViewOptions,
	InternalNode,
	Node,
	NodeChange,
	NodeDimensionChange,
	NodePositionChange,
	NodeSelectionChange,
	Transform,
	XYPosition
} from "./types";

export const SELECTED_NODE_Z = 1000;

/** Rectangle du lasso : départ en coordonnées flow, rect affiché en écran. */
export type UserSelectionRect = {
	startX: number;
	startY: number;
	x: number;
	y: number;
	width: number;
	height: number;
};

export type NodeDragHandler = (
	event: MouseEvent,
	node: Node,
	nodes: Node[]
) => void;
export type SelectionChangeHandler = (params: {
	nodes: Node[];
	edges: Edge[];
}) => void;

/** Ce qu'un drag déplace : position courante + décalage pointeur → coin. */
export type DragItem = {
	id: string;
	position: XYPosition;
	distance: XYPosition;
};

export type CanvasState = {
	/** Préfixe des ids SVG (patterns, markers) — unique par instance. */
	instanceId: string;
	width: number;
	height: number;
	transform: Transform;
	minZoom: number;
	maxZoom: number;
	/** Racine `.nest-canvas`, base des conversions écran → flow. */
	domNode: HTMLDivElement | null;
	viewportNode: HTMLDivElement | null;
	panZoom: PanZoom | null;
	nodes: Node[];
	nodeLookup: Map<string, InternalNode>;
	nodesInitialized: boolean;
	edges: Edge[];
	elevateNodesOnSelect: boolean;
	onNodesChange: ((changes: NodeChange[]) => void) | null;
	paneDragging: boolean;
	fitViewQueued: FitViewOptions | null;
	/** Shift / Cmd / Ctrl enfoncé : un clic ajoute ou retire de la sélection. */
	multiSelectionActive: boolean;
	userSelectionActive: boolean;
	userSelectionRect: UserSelectionRect | null;
	onNodeDragStart: NodeDragHandler | null;
	onNodeDrag: NodeDragHandler | null;
	onNodeDragStop: NodeDragHandler | null;
	onNodesDelete: ((nodes: Node[]) => void) | null;
	onSelectionChangeHandlers: SelectionChangeHandler[];
	/** Annonce lecteur d'écran après un déplacement clavier. */
	ariaLiveMessage: string;
};

type Listener = () => void;
type PartialState =
	| Partial<CanvasState>
	| ((s: CanvasState) => Partial<CanvasState>);

export type CanvasStore = {
	getState: () => CanvasState;
	setState: (partial: PartialState) => void;
	subscribe: (listener: Listener) => () => void;
	setNodes: (nodes: Node[]) => void;
	setEdges: (edges: Edge[]) => void;
	updateNodeDimensions: (elements: Iterable<HTMLElement>) => void;
	fitView: (options?: FitViewOptions) => Promise<boolean>;
	triggerNodeChanges: (changes: NodeChange[]) => void;
	/** Sélectionne `ids` (en plus de l'existant si la multi-sélection est active). */
	addSelectedNodes: (ids: string[]) => void;
	unselectNodes: (nodes?: Node[]) => void;
	resetSelectedElements: () => void;
	/** Sélectionne exactement `ids`, désélectionne le reste. */
	selectExactly: (ids: Set<string>) => void;
	updateNodePositions: (items: Iterable<DragItem>, dragging: boolean) => void;
	/** Pan immédiat en pixels écran ; vrai si la vue a bougé. */
	panBy: (delta: XYPosition) => boolean;
	deleteSelectedNodes: () => void;
};

const selectChange = (id: string, selected: boolean): NodeSelectionChange => ({
	id,
	type: "select",
	selected
});

let instanceCount = 0;

function zFor(node: Node, elevate: boolean): number {
	const zIndex =
		typeof node.zIndex === "number" && Number.isFinite(node.zIndex)
			? node.zIndex
			: 0;
	return zIndex + (node.selected && elevate ? SELECTED_NODE_Z : 0);
}

/**
 * Reconstruit le lookup interne depuis les nodes user. Un node user inchangé
 * (même référence) garde son node interne — et donc sa mesure.
 */
function adoptNodes(
	nodes: Node[],
	lookup: Map<string, InternalNode>,
	elevate: boolean
): boolean {
	const previous = new Map(lookup);
	lookup.clear();
	let initialized = nodes.length > 0;
	for (const userNode of nodes) {
		const prev = previous.get(userNode.id);
		const internal: InternalNode =
			prev !== undefined && prev.internals.userNode === userNode
				? prev
				: {
						...userNode,
						measured: {
							width: userNode.measured?.width,
							height: userNode.measured?.height
						},
						internals: {
							positionAbsolute: {
								x: userNode.position.x,
								y: userNode.position.y
							},
							z: zFor(userNode, elevate),
							userNode,
							// Un node re-créé sans `measured` doit être re-mesuré.
							...(prev?.internals.measuredOnce &&
							userNode.measured !== undefined
								? { measuredOnce: true as const }
								: {})
						}
					};
		lookup.set(userNode.id, internal);
		if (
			(internal.measured.width === undefined ||
				internal.measured.height === undefined) &&
			!internal.hidden
		) {
			initialized = false;
		}
	}
	return initialized;
}

export function createCanvasStore(init: {
	minZoom: number;
	maxZoom: number;
	transform: Transform;
}): CanvasStore {
	instanceCount += 1;
	let state: CanvasState = {
		instanceId: String(instanceCount),
		width: 0,
		height: 0,
		transform: init.transform,
		minZoom: init.minZoom,
		maxZoom: init.maxZoom,
		domNode: null,
		viewportNode: null,
		panZoom: null,
		nodes: [],
		nodeLookup: new Map(),
		nodesInitialized: false,
		edges: [],
		elevateNodesOnSelect: true,
		onNodesChange: null,
		paneDragging: false,
		fitViewQueued: null,
		multiSelectionActive: false,
		userSelectionActive: false,
		userSelectionRect: null,
		onNodeDragStart: null,
		onNodeDrag: null,
		onNodeDragStop: null,
		onNodesDelete: null,
		onSelectionChangeHandlers: [],
		ariaLiveMessage: ""
	};
	const listeners = new Set<Listener>();

	const getState = () => state;
	const setState = (partial: PartialState) => {
		const next = typeof partial === "function" ? partial(state) : partial;
		state = { ...state, ...next };
		for (const l of listeners) l();
	};
	const subscribe = (listener: Listener) => {
		listeners.add(listener);
		return () => listeners.delete(listener);
	};

	const triggerNodeChanges = (changes: NodeChange[]) => {
		if (changes.length > 0) state.onNodesChange?.(changes);
	};

	const runFitView = (options: FitViewOptions) => {
		const { nodeLookup, width, height, minZoom, maxZoom, panZoom } = state;
		if (panZoom === null || nodeLookup.size === 0) return;
		const ids = options.nodes ? new Set(options.nodes.map((n) => n.id)) : null;
		const toFit: InternalNode[] = [];
		for (const n of nodeLookup.values()) {
			const visible = options.includeHiddenNodes
				? hasDimensions(n)
				: Boolean(n.measured.width && n.measured.height && !n.hidden);
			if (visible && (ids === null || ids.has(n.id))) toFit.push(n);
		}
		const viewport = viewportForBounds(
			internalNodesBounds(toFit),
			width,
			height,
			options.minZoom ?? minZoom,
			options.maxZoom ?? maxZoom,
			options.padding ?? 0.1
		);
		panZoom.setViewport(viewport, { duration: options.duration });
	};

	const setNodes = (nodes: Node[]) => {
		const initialized = adoptNodes(
			nodes,
			state.nodeLookup,
			state.elevateNodesOnSelect
		);
		const queued = state.fitViewQueued;
		if (queued !== null && initialized) {
			setState({ nodes, nodesInitialized: true, fitViewQueued: null });
			runFitView(queued);
		} else {
			setState({ nodes, nodesInitialized: initialized });
		}
	};

	const setEdges = (edges: Edge[]) => setState({ edges });

	const updateNodeDimensions = (elements: Iterable<HTMLElement>) => {
		const { nodeLookup } = state;
		const changes: NodeDimensionChange[] = [];
		let updated = false;
		for (const el of elements) {
			const id = el.getAttribute("data-id");
			const node = id === null ? undefined : nodeLookup.get(id);
			if (node === undefined || node.hidden) continue;
			const width = el.offsetWidth;
			const height = el.offsetHeight;
			if (!width || !height) continue;
			const changed =
				node.measured.width !== width || node.measured.height !== height;
			if (!changed && node.internals.measuredOnce) continue;
			nodeLookup.set(node.id, {
				...node,
				measured: { width, height },
				internals: { ...node.internals, measuredOnce: true }
			});
			updated = true;
			if (changed)
				changes.push({
					id: node.id,
					type: "dimensions",
					dimensions: { width, height }
				});
		}
		if (!updated) return;
		const queued = state.fitViewQueued;
		if (queued !== null) {
			setState({ fitViewQueued: null });
			runFitView(queued);
		} else {
			setState({});
		}
		triggerNodeChanges(changes);
	};

	// Différé à la frame suivante : les nodes posés dans le même tick sont
	// adoptés d'abord. S'ils ne sont pas encore mesurés, la mesure déclenche
	// le fit (cf. `updateNodeDimensions`).
	const fitView = async (options: FitViewOptions = {}) => {
		setState({ fitViewQueued: options });
		requestAnimationFrame(() => {
			if (state.fitViewQueued !== null) setNodes(state.nodes);
		});
		return true;
	};

	/**
	 * Changes de sélection pour atteindre exactement `ids`. Le node interne est
	 * muté tout de suite : un drag qui démarre dans le même geste doit voir la
	 * nouvelle sélection avant que l'app ait renvoyé ses nodes.
	 */
	const selectionChanges = (ids: Set<string>): NodeSelectionChange[] => {
		const changes: NodeSelectionChange[] = [];
		for (const node of state.nodeLookup.values()) {
			const next = ids.has(node.id);
			if (!(node.selected === undefined && !next) && node.selected !== next) {
				node.selected = next;
				changes.push(selectChange(node.id, next));
			}
		}
		return changes;
	};

	const selectExactly = (ids: Set<string>) =>
		triggerNodeChanges(selectionChanges(ids));

	const addSelectedNodes = (ids: string[]) => {
		if (state.multiSelectionActive) {
			triggerNodeChanges(ids.map((id) => selectChange(id, true)));
			return;
		}
		selectExactly(new Set(ids));
	};

	const unselectNodes = (nodes: Node[] = state.nodes) => {
		const changes: NodeSelectionChange[] = [];
		for (const node of nodes) {
			if (!node.selected) continue;
			const internal = state.nodeLookup.get(node.id);
			if (internal) internal.selected = false;
			changes.push(selectChange(node.id, false));
		}
		triggerNodeChanges(changes);
	};

	const resetSelectedElements = () => {
		triggerNodeChanges(
			state.nodes
				.filter((n) => n.selected)
				.map((n) => selectChange(n.id, false))
		);
	};

	const updateNodePositions = (
		items: Iterable<DragItem>,
		dragging: boolean
	) => {
		const changes: NodePositionChange[] = [];
		for (const item of items) {
			changes.push({
				id: item.id,
				type: "position",
				position: item.position,
				dragging
			});
		}
		triggerNodeChanges(changes);
	};

	const panBy = (delta: XYPosition) => {
		const { panZoom, transform } = state;
		if (panZoom === null || (!delta.x && !delta.y)) return false;
		panZoom.setViewport({
			x: transform[0] + delta.x,
			y: transform[1] + delta.y,
			zoom: transform[2]
		});
		const next = state.transform;
		return (
			next[0] !== transform[0] ||
			next[1] !== transform[1] ||
			next[2] !== transform[2]
		);
	};

	const deleteSelectedNodes = () => {
		const doomed = state.nodes.filter(
			(n) => n.selected && n.deletable !== false
		);
		if (doomed.length === 0) return;
		state.onNodesDelete?.(doomed);
		triggerNodeChanges(
			doomed.map((n) => ({ id: n.id, type: "remove" as const }))
		);
	};

	return {
		getState,
		setState,
		subscribe,
		setNodes,
		setEdges,
		updateNodeDimensions,
		fitView,
		triggerNodeChanges,
		addSelectedNodes,
		unselectNodes,
		resetSelectedElements,
		selectExactly,
		updateNodePositions,
		panBy,
		deleteSelectedNodes
	};
}

/** Ids des nodes à rendre — tous, ou seulement ceux qui touchent l'écran. */
export function visibleNodeIds(s: CanvasState, onlyVisible: boolean): string[] {
	if (!onlyVisible) return Array.from(s.nodeLookup.keys());
	return getNodesInside(
		s.nodeLookup.values(),
		{ x: 0, y: 0, width: s.width, height: s.height },
		s.transform,
		true
	).map((n) => n.id);
}
