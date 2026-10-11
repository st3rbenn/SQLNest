import {
	getNodesInside,
	hasDimensions,
	internalNodesBounds,
	viewportForBounds
} from "./geometry";
import { measureHandleBounds, renderedZoom } from "./handles";
import type { PanZoom } from "./panZoom";
import {
	calculateZ,
	type ExpandChild,
	handleExpandParent,
	type ParentLookup,
	updateChildNode
} from "./parents";
import type {
	ConnectionState,
	Edge,
	FitViewOptions,
	HandleType,
	InternalNode,
	Node,
	NodeChange,
	NodeDimensionChange,
	NodeSelectionChange,
	Transform,
	XYPosition
} from "./types";

export const initialConnection: ConnectionState = {
	inProgress: false,
	isValid: null,
	from: null,
	fromHandle: null,
	fromPosition: null,
	fromNode: null,
	to: null,
	toHandle: null,
	toPosition: null,
	toNode: null,
	pointer: null
};

/** Handle cliqué en premier d'une connexion « au clic ». */
export type ClickStartHandle = {
	nodeId: string;
	type: HandleType;
	id: string | null;
};

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

/**
 * Ce qu'un drag déplace : position (relative au parent), position absolue
 * et décalage pointeur → coin.
 */
export type DragItem = {
	id: string;
	position: XYPosition;
	positionAbsolute: XYPosition;
	distance: XYPosition;
	/** Parent visé pendant le drag (re-parentage) ; absent = parent actuel. */
	parentId?: string | null;
};

export type CanvasState = {
	/** Préfixe des ids DOM (handles, markers, motif, descriptions) : l'`id`
	 *  du canvas, « 1 » par défaut. Deux canvas sur une page doivent avoir
	 *  chacun leur `id`. */
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
	/** Enfants directs par parent. */
	parentLookup: ParentLookup;
	nodesInitialized: boolean;
	edges: Edge[];
	edgeLookup: Map<string, Edge>;
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
	connection: ConnectionState;
	connectionClickStartHandle: ClickStartHandle | null;
	/** Re-parentage pendant un drag : un node peut-il rejoindre `parent` (`null` : racine) ? */
	canReparent: ((node: Node, parent: Node | null) => boolean) | null;
	/** Conteneur visé par le drag en cours. */
	dropTargetId: string | null;
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
	/** Changes de position (ou de parent) des items ; `before` passe en tête. */
	updateNodePositions: (
		items: Iterable<DragItem>,
		dragging: boolean,
		before?: NodeChange[]
	) => NodeChange[];
	/** Pan immédiat en pixels écran ; vrai si la vue a bougé. */
	panBy: (delta: XYPosition) => boolean;
	deleteSelectedNodes: () => void;
	updateConnection: (connection: ConnectionState) => void;
	cancelConnection: () => void;
};

const selectChange = (id: string, selected: boolean): NodeSelectionChange => ({
	id,
	type: "select",
	selected
});

/**
 * Reconstruit le lookup interne depuis les nodes user. Un node user inchangé
 * (même référence) garde son node interne — et donc sa mesure. Les enfants
 * tirent position absolue et z de leur parent, adopté avant eux.
 */
function adoptNodes(
	nodes: Node[],
	lookup: Map<string, InternalNode>,
	parentLookup: ParentLookup,
	elevate: boolean
): boolean {
	const previous = new Map(lookup);
	const selectedZ = elevate ? SELECTED_NODE_Z : 0;
	lookup.clear();
	parentLookup.clear();
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
							z: calculateZ(userNode, selectedZ),
							userNode,
							// Un node re-créé sans `measured` doit être re-mesuré.
							...(prev?.internals.measuredOnce &&
							userNode.measured !== undefined
								? {
										measuredOnce: true as const,
										...(prev.internals.handleBounds
											? { handleBounds: prev.internals.handleBounds }
											: {})
									}
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
	// Les enfants après tous les parents, quel que soit l'ordre du tableau :
	// un re-parentage ne réordonne pas les nodes de l'app.
	const resolved = new Set<string>();
	const resolve = (id: string, depth: number) => {
		const node = lookup.get(id);
		if (node === undefined || resolved.has(id)) return;
		resolved.add(id);
		if (!node.parentId || depth > lookup.size) return;
		resolve(node.parentId, depth + 1);
		updateChildNode(
			lookup.get(id) as InternalNode,
			lookup,
			parentLookup,
			selectedZ
		);
	};
	for (const id of Array.from(lookup.keys())) resolve(id, 0);
	return initialized;
}

export function createCanvasStore(init: {
	minZoom: number;
	maxZoom: number;
	transform: Transform;
}): CanvasStore {
	let state: CanvasState = {
		instanceId: "1",
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
		parentLookup: new Map(),
		nodesInitialized: false,
		edges: [],
		edgeLookup: new Map(),
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
		ariaLiveMessage: "",
		connection: initialConnection,
		connectionClickStartHandle: null,
		canReparent: null,
		dropTargetId: null
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
			state.parentLookup,
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

	const setEdges = (edges: Edge[]) =>
		setState({ edges, edgeLookup: new Map(edges.map((e) => [e.id, e])) });

	// Chaque appel re-mesure taille ET handles (ResizeObserver comme
	// changement de position de handle passent par ici).
	const updateNodeDimensions = (elements: Iterable<HTMLElement>) => {
		const { nodeLookup, viewportNode, transform } = state;
		if (viewportNode === null) return;
		const zoom = renderedZoom(viewportNode, transform[2]);
		const changes: NodeDimensionChange[] = [];
		let updated = false;
		for (const el of elements) {
			const id = el.getAttribute("data-id");
			const node = id === null ? undefined : nodeLookup.get(id);
			if (node === undefined) continue;
			if (node.hidden) {
				const { handleBounds: _hidden, ...internals } = node.internals;
				nodeLookup.set(node.id, { ...node, internals });
				updated = true;
				continue;
			}
			const width = el.offsetWidth;
			const height = el.offsetHeight;
			if (!width || !height) continue;
			const changed =
				node.measured.width !== width || node.measured.height !== height;
			nodeLookup.set(node.id, {
				...node,
				measured: { width, height },
				internals: {
					...node.internals,
					measuredOnce: true,
					handleBounds: measureHandleBounds(el, zoom, node.id)
				}
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

	// Un enfant `expandParent` ne passe pas au-dessus / à gauche de son
	// parent : c'est le parent qui s'agrandit (cf. `handleExpandParent`).
	const updateNodePositions = (
		items: Iterable<DragItem>,
		dragging: boolean,
		before: NodeChange[] = []
	) => {
		const { nodeLookup, parentLookup } = state;
		const changes: NodeChange[] = [...before];
		const expandChildren: ExpandChild[] = [];
		for (const item of items) {
			const node = nodeLookup.get(item.id);
			const parentId =
				item.parentId === undefined
					? node?.parentId
					: (item.parentId ?? undefined);
			const expandParent = Boolean(node?.expandParent && parentId);
			const position = expandParent
				? { x: Math.max(0, item.position.x), y: Math.max(0, item.position.y) }
				: item.position;
			if (
				item.parentId !== undefined &&
				(item.parentId ?? undefined) !== node?.parentId
			) {
				changes.push({
					id: item.id,
					type: "parent",
					parentId: item.parentId,
					position,
					dragging
				});
			} else {
				changes.push({ id: item.id, type: "position", position, dragging });
			}
			if (expandParent && parentId && node) {
				const { width, height } = node.measured;
				expandChildren.push({
					id: item.id,
					parentId,
					rect: {
						...item.positionAbsolute,
						width: width ?? 0,
						height: height ?? 0
					}
				});
			}
		}
		if (expandChildren.length > 0) {
			changes.push(
				...handleExpandParent(expandChildren, nodeLookup, parentLookup)
			);
		}
		triggerNodeChanges(changes);
		return changes;
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

	// Supprimer un parent emporte ses descendants supprimables.
	const deleteSelectedNodes = () => {
		const doomed: Node[] = [];
		const doomedIds = new Set<string>();
		for (const n of state.nodes) {
			if (n.deletable === false) continue;
			const parentHit =
				!n.selected && n.parentId !== undefined && doomedIds.has(n.parentId);
			if (n.selected || parentHit) {
				doomed.push(n);
				doomedIds.add(n.id);
			}
		}
		if (doomed.length === 0) return;
		state.onNodesDelete?.(doomed);
		triggerNodeChanges(
			doomed.map((n) => ({ id: n.id, type: "remove" as const }))
		);
	};

	const updateConnection = (connection: ConnectionState) =>
		setState({ connection });
	const cancelConnection = () => setState({ connection: initialConnection });

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
		deleteSelectedNodes,
		updateConnection,
		cancelConnection
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
