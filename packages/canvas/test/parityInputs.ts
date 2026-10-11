/**
 * Entrées pseudo-aléatoires (graine fixe) des tests de parité. Les sorties
 * attendues ont été calculées une fois par React Flow (`@xyflow/system`
 * 0.0.79, `@xyflow/react` 12.11.2) et figées dans `fixtures/parity.json` :
 * toute modification de ce fichier invalide les fixtures.
 */
import type {
	Edge,
	EdgeMarker,
	HandleBound,
	InternalNode,
	Node,
	NodeChange,
	Position,
	Rect,
	Transform,
	XYPosition
} from "../src/types";

function rng(seed: number) {
	let s = seed >>> 0;
	return () => {
		s = (s * 1664525 + 1013904223) >>> 0;
		return s / 2 ** 32;
	};
}

const POSITIONS = ["left", "top", "right", "bottom"] as Position[];

export function parityInputs() {
	const rand = rng(2026);
	const between = (min: number, max: number) => min + rand() * (max - min);
	const pick = <T>(items: T[]): T =>
		items[Math.floor(rand() * items.length)] as T;
	const transform = (): Transform => [
		between(-2000, 2000),
		between(-2000, 2000),
		between(0.02, 1.75)
	];

	const viewportForBounds = Array.from({ length: 300 }, () => ({
		bounds: {
			x: between(-5000, 5000),
			y: between(-5000, 5000),
			width: between(1, 8000),
			height: between(1, 8000)
		},
		width: between(200, 3000),
		height: between(200, 2000),
		minZoom: between(0.01, 0.6),
		maxZoom: between(0.8, 3),
		padding: between(0, 0.6)
	}));

	const points = Array.from({ length: 200 }, () => ({
		transform: transform(),
		point: { x: between(-3000, 3000), y: between(-3000, 3000) }
	}));

	const autoPan = Array.from({ length: 300 }, () => {
		const bounds = { width: between(100, 2500), height: between(100, 1600) };
		const pos: XYPosition = {
			x: between(-100, bounds.width + 100),
			y: between(-100, bounds.height + 100)
		};
		return { pos, bounds };
	});

	const nodesInside = Array.from({ length: 12 }, () => {
		const nodes: InternalNode[] = Array.from({ length: 60 }, (_, i) => {
			const measuredOnce = rand() > 0.1;
			const position = { x: between(-4000, 4000), y: between(-3000, 3000) };
			const user: Node = {
				id: `n${i}`,
				position,
				data: {},
				hidden: rand() > 0.95,
				selectable: rand() > 0.2,
				dragging: rand() > 0.97
			};
			return {
				...user,
				measured: { width: between(20, 600), height: between(20, 900) },
				internals: {
					positionAbsolute: position,
					z: 0,
					userNode: user,
					...(measuredOnce ? { measuredOnce: true as const } : {})
				}
			};
		});
		const rect: Rect = {
			x: 0,
			y: 0,
			width: between(300, 2500),
			height: between(300, 1500)
		};
		return { nodes, rect, transform: transform() };
	});

	const baseNodes: Node[] = Array.from({ length: 30 }, (_, i) => ({
		id: `n${i}`,
		position: { x: i * 10, y: i * 5 },
		data: { i }
	}));
	const applyNodeChanges = Array.from({ length: 20 }, (_, round) => {
		const changes: NodeChange[] = [];
		for (let k = 0; k < 12; k++) {
			const id = `n${Math.floor(between(0, 30))}`;
			const r = rand();
			if (r < 0.2) changes.push({ id, type: "select", selected: rand() > 0.5 });
			else if (r < 0.45)
				changes.push({
					id,
					type: "position",
					position: { x: between(-100, 100), y: between(-100, 100) },
					dragging: rand() > 0.5
				});
			else if (r < 0.7)
				changes.push({
					id,
					type: "dimensions",
					dimensions: { width: between(10, 500), height: between(10, 500) },
					setAttributes: rand() > 0.5,
					resizing: rand() > 0.5
				});
			else if (r < 0.8) changes.push({ id, type: "remove" });
			else if (r < 0.9)
				changes.push({
					id,
					type: "replace",
					item: { id, position: { x: 1, y: 2 }, data: {} }
				});
			else
				changes.push({
					type: "add",
					item: { id: `new${round}-${k}`, position: { x: 0, y: 0 }, data: {} },
					...(rand() > 0.5 ? { index: Math.floor(between(0, 10)) } : {})
				});
		}
		return changes;
	});

	const smoothStep = Array.from({ length: 300 }, () => {
		const sourceX = between(-2000, 2000);
		const sourceY = between(-2000, 2000);
		// Un quart des cas : extrémités proches (< offset) ou alignées.
		const near = rand() < 0.25;
		const targetX = near
			? sourceX + Math.round(between(-30, 30))
			: rand() < 0.1
				? sourceX
				: between(-2000, 2000);
		const targetY = near
			? sourceY + Math.round(between(-30, 30))
			: rand() < 0.1
				? sourceY
				: between(-2000, 2000);
		return {
			sourceX,
			sourceY,
			targetX,
			targetY,
			sourcePosition: pick(POSITIONS),
			targetPosition: pick(POSITIONS),
			...(rand() < 0.2 ? { borderRadius: between(0, 30) } : {}),
			...(rand() < 0.2 ? { offset: between(0, 60) } : {}),
			...(rand() < 0.2 ? { stepPosition: rand() } : {}),
			...(rand() < 0.1 ? { centerX: between(-2000, 2000) } : {}),
			...(rand() < 0.1 ? { centerY: between(-2000, 2000) } : {})
		};
	});

	const handles = (
		nodeId: string,
		type: "source" | "target",
		w: number,
		h: number
	): HandleBound[] | null =>
		rand() < 0.05
			? null
			: POSITIONS.map((position) => ({
					id: rand() < 0.1 ? null : position,
					type,
					nodeId,
					position,
					x:
						position === "left" ? -3 : position === "right" ? w - 3 : w / 2 - 3,
					y:
						position === "top" ? -3 : position === "bottom" ? h - 3 : h / 2 - 3,
					width: 6,
					height: 6
				}));
	const internalNode = (id: string): InternalNode => {
		const w = between(40, 600);
		const h = between(40, 900);
		const position = { x: between(-4000, 4000), y: between(-3000, 3000) };
		const user: Node = {
			id,
			position,
			data: {},
			...(rand() < 0.1 ? { parentId: "p" } : {}),
			...(rand() < 0.3 ? { selected: true } : {})
		};
		const measuredOnce = rand() > 0.05;
		return {
			...user,
			measured: measuredOnce ? { width: w, height: h } : {},
			internals: {
				positionAbsolute: position,
				z: Math.floor(between(0, 2000)),
				userNode: user,
				...(measuredOnce
					? {
							measuredOnce: true as const,
							handleBounds: {
								source: handles(id, "source", w, h),
								target: handles(id, "target", w, h)
							}
						}
					: {})
			}
		};
	};
	const edges = Array.from({ length: 300 }, () => {
		const sourceNode = internalNode("s");
		const targetNode = internalNode("t");
		const sourceHandle = rand() < 0.2 ? null : pick([...POSITIONS, "x"]);
		const targetHandle = rand() < 0.2 ? null : pick([...POSITIONS, "x"]);
		const z = {
			selected: rand() < 0.5,
			zIndex: rand() < 0.5 ? Math.floor(between(0, 20)) : undefined,
			elevateOnSelect: rand() < 0.5
		};
		const view = {
			width: between(200, 3000),
			height: between(200, 2000),
			transform: transform()
		};
		return { sourceNode, targetNode, sourceHandle, targetHandle, z, view };
	});

	const markerList: EdgeMarker[] = [
		{ type: "arrowclosed" as EdgeMarker["type"], width: 14, height: 14 },
		{ type: "arrow" as EdgeMarker["type"] },
		{
			type: "arrowclosed" as EdgeMarker["type"],
			color: "#f00",
			strokeWidth: 2
		},
		{
			type: "arrow" as EdgeMarker["type"],
			orient: "auto",
			markerUnits: "userSpaceOnUse"
		}
	];
	const markerEdges: Edge[] = Array.from({ length: 40 }, (_, i) => ({
		id: `e${i}`,
		source: "a",
		target: "b",
		...(rand() < 0.8 ? { markerEnd: pick(markerList) } : {}),
		...(rand() < 0.3 ? { markerStart: pick(markerList) } : {}),
		...(rand() < 0.05 ? { markerEnd: "custom-id" } : {})
	}));
	const markers = {
		ids: [...markerList, "custom-id", undefined] as (
			| EdgeMarker
			| string
			| undefined
		)[],
		edges: markerEdges
	};

	const bezier = Array.from({ length: 150 }, () => ({
		sourceX: between(-2000, 2000),
		sourceY: between(-2000, 2000),
		sourcePosition: pick(POSITIONS),
		targetX: between(-2000, 2000),
		targetY: between(-2000, 2000),
		targetPosition: pick(POSITIONS)
	}));

	const handlePosition = Array.from({ length: 200 }, () => {
		const user: Node = { id: "n", position: { x: 0, y: 0 }, data: {} };
		const node: InternalNode = {
			...user,
			measured: { width: between(50, 400), height: between(30, 600) },
			internals: {
				positionAbsolute: { x: between(-3000, 3000), y: between(-3000, 3000) },
				z: 0,
				userNode: user
			}
		};
		const handle: HandleBound = {
			id: "h",
			type: "source",
			nodeId: "n",
			position: pick(POSITIONS),
			x: between(-10, 300),
			y: between(-10, 300),
			width: between(1, 10),
			height: between(1, 10)
		};
		return { node, handle, center: rand() > 0.5 };
	});

	// Forêts parent / enfant : parents toujours avant leurs enfants.
	const forests = Array.from({ length: 30 }, () => {
		const nodes: Node[] = [];
		for (let i = 0; i < 25; i++) {
			const parents = nodes.filter(() => rand() < 0.3);
			const parent = rand() < 0.6 && parents.length > 0 ? pick(parents) : null;
			nodes.push({
				id: `n${i}`,
				position: { x: between(-500, 1500), y: between(-500, 1500) },
				data: {},
				measured: { width: between(40, 600), height: between(40, 600) },
				...(parent ? { parentId: parent.id } : {}),
				...(rand() < 0.3 ? { zIndex: Math.floor(between(-3, 4)) } : {}),
				...(rand() < 0.2 ? { selected: true } : {}),
				...(rand() < 0.3 ? { expandParent: true } : {})
			} as Node);
		}
		const moves = Array.from({ length: 6 }, () => ({
			id: `n${Math.floor(between(0, 25))}`,
			next: { x: between(-800, 1800), y: between(-800, 1800) }
		}));
		const expand = Array.from({ length: 4 }, () => ({
			id: `n${Math.floor(between(0, 25))}`,
			rect: {
				x: between(-900, 1900),
				y: between(-900, 1900),
				width: between(40, 700),
				height: between(40, 700)
			}
		}));
		return { nodes, moves, expand };
	});

	return {
		forests,
		viewportForBounds,
		points,
		autoPan,
		nodesInside,
		baseNodes,
		applyNodeChanges,
		smoothStep,
		edges,
		markers,
		bezier,
		handlePosition
	};
}
