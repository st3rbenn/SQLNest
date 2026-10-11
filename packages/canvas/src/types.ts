import type { ComponentType, CSSProperties, MouseEvent } from "react";

export type XYPosition = { x: number; y: number };
export type Dimensions = { width: number; height: number };
export type Rect = XYPosition & Dimensions;
/** `[x, y, zoom]` — même ordre que la transform CSS du viewport. */
export type Transform = [number, number, number];
export type Viewport = { x: number; y: number; zoom: number };

export enum Position {
	Left = "left",
	Top = "top",
	Right = "right",
	Bottom = "bottom"
}

export enum SelectionMode {
	Partial = "partial",
	Full = "full"
}

export enum MarkerType {
	Arrow = "arrow",
	ArrowClosed = "arrowclosed"
}

export type Node<
	TData extends Record<string, unknown> = Record<string, unknown>,
	TType extends string | undefined = string | undefined
> = {
	id: string;
	position: XYPosition;
	data: TData;
	type?: TType;
	selected?: boolean;
	dragging?: boolean;
	resizing?: boolean;
	draggable?: boolean;
	selectable?: boolean;
	deletable?: boolean;
	focusable?: boolean;
	hidden?: boolean;
	width?: number;
	height?: number;
	initialWidth?: number;
	initialHeight?: number;
	measured?: { width?: number | undefined; height?: number | undefined };
	zIndex?: number;
	className?: string;
	style?: CSSProperties;
	sourcePosition?: Position;
	targetPosition?: Position;
	dragHandle?: string;
	/** Parent : `position` est alors relative à son coin haut-gauche. */
	parentId?: string;
	/** Poussé hors de son parent pendant un drag, l'enfant l'agrandit. */
	expandParent?: boolean;
	ariaLabel?: string;
	ariaRole?: string;
};

export type Edge<
	TData extends Record<string, unknown> = Record<string, unknown>,
	TType extends string | undefined = string | undefined
> = {
	id: string;
	source: string;
	target: string;
	sourceHandle?: string | null;
	targetHandle?: string | null;
	type?: TType;
	data?: TData;
	selected?: boolean;
	selectable?: boolean;
	deletable?: boolean;
	focusable?: boolean;
	hidden?: boolean;
	animated?: boolean;
	zIndex?: number;
	className?: string;
	style?: CSSProperties;
	markerStart?: EdgeMarker | string;
	markerEnd?: EdgeMarker | string;
	interactionWidth?: number;
	label?: string;
};

export type EdgeMarker = {
	type: MarkerType;
	color?: string;
	width?: number;
	height?: number;
	markerUnits?: string;
	orient?: string;
	strokeWidth?: number;
};

export type HandleType = "source" | "target";

/** Handle mesuré, coordonnées relatives au coin du node (unités flow). */
export type HandleBound = {
	id: string | null;
	type: HandleType;
	nodeId: string;
	position: Position;
	x: number;
	y: number;
	width: number;
	height: number;
};

export type HandleBounds = {
	source: HandleBound[] | null;
	target: HandleBound[] | null;
};

/** Node tel que le moteur le garde : node user + position absolue, z, mesure. */
export type InternalNode<TNode extends Node = Node> = TNode & {
	measured: { width?: number | undefined; height?: number | undefined };
	internals: {
		positionAbsolute: XYPosition;
		z: number;
		userNode: TNode;
		/** Posé à la première mesure DOM — tant qu'il est absent le node est
		 *  rendu même hors écran pour pouvoir être mesuré. */
		measuredOnce?: true;
		handleBounds?: HandleBounds;
	};
};

/** Connexion en cours depuis un handle (`to` / `pointer` en pixels écran). */
export type ConnectionState = {
	inProgress: boolean;
	isValid: boolean | null;
	from: XYPosition | null;
	fromHandle: HandleBound | null;
	fromPosition: Position | null;
	fromNode: InternalNode | null;
	to: XYPosition | null;
	toHandle: HandleBound | null;
	toPosition: Position | null;
	toNode: InternalNode | null;
	pointer: XYPosition | null;
};

export type NodeProps<TNode extends Node = Node> = Pick<
	TNode,
	| "id"
	| "data"
	| "dragHandle"
	| "type"
	| "parentId"
	| "sourcePosition"
	| "targetPosition"
> & {
	width?: number;
	height?: number;
	positionAbsoluteX: number;
	positionAbsoluteY: number;
	selected: boolean;
	selectable: boolean;
	draggable: boolean;
	deletable: boolean;
	isConnectable: boolean;
	dragging: boolean;
	zIndex: number;
};

export type EdgeProps<TEdge extends Edge = Edge> = {
	id: string;
	source: string;
	target: string;
	data?: TEdge["data"] | undefined;
	style?: CSSProperties | undefined;
	selected?: boolean | undefined;
	animated?: boolean | undefined;
	selectable?: boolean | undefined;
	deletable?: boolean | undefined;
	sourceX: number;
	sourceY: number;
	targetX: number;
	targetY: number;
	sourcePosition: Position;
	targetPosition: Position;
	sourceHandleId?: string | null | undefined;
	targetHandleId?: string | null | undefined;
	markerStart?: string | undefined;
	markerEnd?: string | undefined;
	interactionWidth?: number | undefined;
	label?: string | undefined;
};

export type NodeDimensionChange = {
	id: string;
	type: "dimensions";
	dimensions?: Dimensions;
	resizing?: boolean;
	setAttributes?: boolean | "width" | "height";
};
export type NodePositionChange = {
	id: string;
	type: "position";
	position?: XYPosition;
	positionAbsolute?: XYPosition;
	dragging?: boolean;
};
export type NodeSelectionChange = {
	id: string;
	type: "select";
	selected: boolean;
};
export type NodeRemoveChange = { id: string; type: "remove" };
export type NodeAddChange<TNode extends Node = Node> = {
	item: TNode;
	type: "add";
	index?: number;
};
export type NodeReplaceChange<TNode extends Node = Node> = {
	id: string;
	item: TNode;
	type: "replace";
};
export type NodeChange<TNode extends Node = Node> =
	| NodeDimensionChange
	| NodePositionChange
	| NodeSelectionChange
	| NodeRemoveChange
	| NodeAddChange<TNode>
	| NodeReplaceChange<TNode>;

export type OnNodesChange<TNode extends Node = Node> = (
	changes: NodeChange<TNode>[]
) => void;

// `any` : un composant typé sur un node précis doit rester assignable ici.
// biome-ignore lint/suspicious/noExplicitAny: variance des props
export type NodeTypes = Record<string, ComponentType<NodeProps<any>>>;
// biome-ignore lint/suspicious/noExplicitAny: variance des props
export type EdgeTypes = Record<string, ComponentType<EdgeProps<any>>>;

export type NodeMouseHandler<TNode extends Node = Node> = (
	event: MouseEvent,
	node: TNode
) => void;

export type FitViewOptions = {
	padding?: number;
	includeHiddenNodes?: boolean;
	minZoom?: number;
	maxZoom?: number;
	duration?: number;
	nodes?: { id: string }[];
};

export type ViewportAnimation = { duration?: number };

export type PanelPosition =
	| "top-left"
	| "top-center"
	| "top-right"
	| "bottom-left"
	| "bottom-center"
	| "bottom-right"
	| "center-left"
	| "center-right";
