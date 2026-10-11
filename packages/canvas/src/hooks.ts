import {
	type Dispatch,
	type SetStateAction,
	useCallback,
	useEffect,
	useMemo,
	useState
} from "react";
import { shallow, useNestStore, useStoreApi } from "./context";
import { flowToPoint, pointToFlow } from "./geometry";
import type { SelectionChangeHandler } from "./store";
import type {
	FitViewOptions,
	InternalNode,
	Node,
	NodeChange,
	Viewport,
	ViewportAnimation,
	XYPosition
} from "./types";

/**
 * Applique des changes émis par le moteur à un tableau de nodes. Seuls les
 * nodes touchés sont copiés, les autres gardent leur référence.
 */
export function applyNodeChanges<TNode extends Node>(
	changes: NodeChange<TNode>[],
	nodes: TNode[]
): TNode[] {
	const byId = new Map<string, NodeChange<TNode>[]>();
	const adds: Extract<NodeChange<TNode>, { type: "add" }>[] = [];
	for (const change of changes) {
		if (change.type === "add") {
			adds.push(change);
		} else if (change.type === "remove" || change.type === "replace") {
			byId.set(change.id, [change]);
		} else {
			const list = byId.get(change.id);
			if (list) list.push(change);
			else byId.set(change.id, [change]);
		}
	}
	const result: TNode[] = [];
	for (const node of nodes) {
		const list = byId.get(node.id);
		if (list === undefined) {
			result.push(node);
			continue;
		}
		const first = list[0];
		if (first?.type === "remove") continue;
		if (first?.type === "replace") {
			result.push({ ...first.item });
			continue;
		}
		const next = { ...node };
		for (const change of list) {
			switch (change.type) {
				case "select":
					next.selected = change.selected;
					break;
				case "position":
					if (change.position !== undefined) next.position = change.position;
					if (change.dragging !== undefined) next.dragging = change.dragging;
					break;
				case "dimensions":
					if (change.dimensions !== undefined) {
						next.measured = { ...change.dimensions };
						if (
							change.setAttributes === true ||
							change.setAttributes === "width"
						) {
							next.width = change.dimensions.width;
						}
						if (
							change.setAttributes === true ||
							change.setAttributes === "height"
						) {
							next.height = change.dimensions.height;
						}
					}
					if (typeof change.resizing === "boolean")
						next.resizing = change.resizing;
					break;
			}
		}
		result.push(next);
	}
	for (const change of adds) {
		if (change.index !== undefined)
			result.splice(change.index, 0, { ...change.item });
		else result.push({ ...change.item });
	}
	return result;
}

export function useNodesState<TNode extends Node>(
	initial: TNode[]
): [
	TNode[],
	Dispatch<SetStateAction<TNode[]>>,
	(changes: NodeChange<TNode>[]) => void
] {
	const [nodes, setNodes] = useState(initial);
	const onNodesChange = useCallback(
		(changes: NodeChange<TNode>[]) =>
			setNodes((prev) => applyNodeChanges(changes, prev)),
		[]
	);
	return [nodes, setNodes, onNodesChange];
}

export function useViewport(): Viewport {
	return useNestStore(
		(s) => ({ x: s.transform[0], y: s.transform[1], zoom: s.transform[2] }),
		shallow
	);
}

export type NestCanvasInstance<TNode extends Node = Node> = {
	getNodes: () => TNode[];
	getNode: (id: string) => TNode | undefined;
	getInternalNode: (id: string) => InternalNode<TNode> | undefined;
	getViewport: () => Viewport;
	getZoom: () => number;
	setViewport: (
		viewport: Partial<Viewport>,
		options?: ViewportAnimation
	) => Promise<boolean>;
	fitView: (options?: FitViewOptions) => Promise<boolean>;
	zoomIn: (options?: ViewportAnimation) => Promise<boolean>;
	zoomOut: (options?: ViewportAnimation) => Promise<boolean>;
	zoomTo: (zoom: number, options?: ViewportAnimation) => Promise<boolean>;
	screenToFlowPosition: (clientPosition: XYPosition) => XYPosition;
	flowToScreenPosition: (flowPosition: XYPosition) => XYPosition;
};

const ZOOM_STEP = 1.2;

export function useNestCanvas<
	TNode extends Node = Node
>(): NestCanvasInstance<TNode> {
	const store = useStoreApi();
	return useMemo(() => {
		const panZoom = () => store.getState().panZoom;
		return {
			getNodes: () => store.getState().nodes.map((n) => ({ ...n })) as TNode[],
			getNode: (id) =>
				store.getState().nodeLookup.get(id)?.internals.userNode as
					| TNode
					| undefined,
			getInternalNode: (id) =>
				store.getState().nodeLookup.get(id) as InternalNode<TNode> | undefined,
			getViewport: () => {
				const [x, y, zoom] = store.getState().transform;
				return { x, y, zoom };
			},
			getZoom: () => store.getState().transform[2],
			setViewport: async (viewport, options) => {
				const pz = panZoom();
				if (pz === null) return false;
				const [x, y, zoom] = store.getState().transform;
				pz.setViewport(
					{
						x: viewport.x ?? x,
						y: viewport.y ?? y,
						zoom: viewport.zoom ?? zoom
					},
					options
				);
				return true;
			},
			fitView: (options) => store.fitView(options),
			zoomIn: async (options) => {
				const pz = panZoom();
				if (pz === null) return false;
				pz.scaleBy(ZOOM_STEP, options);
				return true;
			},
			zoomOut: async (options) => {
				const pz = panZoom();
				if (pz === null) return false;
				pz.scaleBy(1 / ZOOM_STEP, options);
				return true;
			},
			zoomTo: async (zoom, options) => {
				const pz = panZoom();
				if (pz === null) return false;
				pz.scaleTo(zoom, options);
				return true;
			},
			screenToFlowPosition: (clientPosition) => {
				const { transform, domNode } = store.getState();
				if (domNode === null) return clientPosition;
				const { x, y } = domNode.getBoundingClientRect();
				return pointToFlow(
					{ x: clientPosition.x - x, y: clientPosition.y - y },
					transform
				);
			},
			flowToScreenPosition: (flowPosition) => {
				const { transform, domNode } = store.getState();
				if (domNode === null) return flowPosition;
				const { x, y } = domNode.getBoundingClientRect();
				const p = flowToPoint(flowPosition, transform);
				return { x: p.x + x, y: p.y + y };
			}
		};
	}, [store]);
}

/** Appelé à chaque changement de l'ensemble des nodes sélectionnés. */
export function useOnSelectionChange({
	onChange
}: {
	onChange: SelectionChangeHandler;
}) {
	const store = useStoreApi();
	useEffect(() => {
		store.setState({
			onSelectionChangeHandlers: [
				...store.getState().onSelectionChangeHandlers,
				onChange
			]
		});
		return () => {
			store.setState({
				onSelectionChangeHandlers: store
					.getState()
					.onSelectionChangeHandlers.filter((fn) => fn !== onChange)
			});
		};
	}, [onChange, store]);
}
