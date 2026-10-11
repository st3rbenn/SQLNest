/**
 * Parité avec React Flow sur les fonctions pures, tant que RF reste installé
 * en référence (ADR-033). Entrées pseudo-aléatoires à graine fixe.
 */
import { applyNodeChanges as rfApplyNodeChanges } from "@xyflow/react";
import {
	ConnectionMode,
	calcAutoPan,
	getViewportForBounds,
	pointToRendererPoint,
	rendererPointToPoint,
	createMarkerIds as rfCreateMarkerIds,
	getEdgePosition as rfGetEdgePosition,
	getElevatedEdgeZIndex as rfGetElevatedEdgeZIndex,
	getMarkerId as rfGetMarkerId,
	getNodesInside as rfGetNodesInside,
	getSmoothStepPath as rfGetSmoothStepPath,
	isEdgeVisible as rfIsEdgeVisible
} from "@xyflow/system";
import { easeCubicInOut } from "d3-ease";
import { interpolateZoom as d3InterpolateZoom } from "d3-interpolate";
import { describe, expect, it } from "vitest";
import {
	createMarkerIds,
	elevatedEdgeZIndex,
	getEdgePosition,
	getMarkerId,
	isEdgeVisible
} from "../src/edges";
import {
	autoPan,
	flowToPoint,
	getNodesInside,
	pointToFlow,
	viewportForBounds
} from "../src/geometry";
import { applyNodeChanges } from "../src/hooks";
import { cubicInOut, interpolateZoom, type View } from "../src/interpolate";
import { getSmoothStepPath } from "../src/paths";
import {
	type Edge,
	type HandleBound,
	type InternalNode,
	MarkerType,
	type Node,
	type NodeChange,
	Position,
	type Transform
} from "../src/types";

function rng(seed: number) {
	let s = seed >>> 0;
	return () => {
		s = (s * 1664525 + 1013904223) >>> 0;
		return s / 2 ** 32;
	};
}
const rand = rng(42);
const between = (min: number, max: number) => min + rand() * (max - min);
const randomTransform = (): Transform => [
	between(-2000, 2000),
	between(-2000, 2000),
	between(0.02, 1.75)
];

describe("parité géométrie", () => {
	it("viewportForBounds = getViewportForBounds", () => {
		for (let i = 0; i < 2000; i++) {
			const bounds = {
				x: between(-5000, 5000),
				y: between(-5000, 5000),
				width: between(1, 8000),
				height: between(1, 8000)
			};
			const width = between(200, 3000);
			const height = between(200, 2000);
			const minZoom = between(0.01, 0.6);
			const maxZoom = between(0.8, 3);
			const padding = between(0, 0.6);
			const ours = viewportForBounds(
				bounds,
				width,
				height,
				minZoom,
				maxZoom,
				padding
			);
			const ref = getViewportForBounds(
				bounds,
				width,
				height,
				minZoom,
				maxZoom,
				padding
			);
			expect(ours.x).toBeCloseTo(ref.x, 9);
			expect(ours.y).toBeCloseTo(ref.y, 9);
			expect(ours.zoom).toBeCloseTo(ref.zoom, 12);
		}
	});

	it("pointToFlow / flowToPoint = pointToRendererPoint / rendererPointToPoint", () => {
		for (let i = 0; i < 1000; i++) {
			const t = randomTransform();
			const p = { x: between(-3000, 3000), y: between(-3000, 3000) };
			expect(pointToFlow(p, t)).toEqual(pointToRendererPoint(p, t));
			expect(flowToPoint(p, t)).toEqual(rendererPointToPoint(p, t));
		}
	});

	it("autoPan = calcAutoPan", () => {
		for (let i = 0; i < 2000; i++) {
			const bounds = { width: between(100, 2500), height: between(100, 1600) };
			const pos = {
				x: between(-100, bounds.width + 100),
				y: between(-100, bounds.height + 100)
			};
			const [ox, oy] = autoPan(pos, bounds);
			const [rx = Number.NaN, ry = Number.NaN] = calcAutoPan(pos, bounds);
			expect(ox).toBeCloseTo(rx, 12);
			expect(oy).toBeCloseTo(ry, 12);
		}
	});

	it("getNodesInside (partiel et total) = getNodesInside RF", () => {
		for (let round = 0; round < 50; round++) {
			const ours: InternalNode[] = [];
			const ref = new Map<string, unknown>();
			for (let i = 0; i < 80; i++) {
				const measuredOnce = rand() > 0.1;
				const hidden = rand() > 0.95;
				const selectable = rand() > 0.2;
				const dragging = rand() > 0.97;
				const w = between(20, 600);
				const h = between(20, 900);
				const pos = { x: between(-4000, 4000), y: between(-3000, 3000) };
				const user: Node = {
					id: `n${i}`,
					position: pos,
					data: {},
					hidden,
					selectable,
					dragging
				};
				ours.push({
					...user,
					measured: { width: w, height: h },
					internals: {
						positionAbsolute: pos,
						z: 0,
						userNode: user,
						...(measuredOnce ? { measuredOnce: true as const } : {})
					}
				});
				ref.set(user.id, {
					...user,
					measured: { width: w, height: h },
					internals: {
						positionAbsolute: pos,
						z: 0,
						userNode: user,
						handleBounds: measuredOnce
							? { source: null, target: null }
							: undefined
					}
				});
			}
			const rect = {
				x: 0,
				y: 0,
				width: between(300, 2500),
				height: between(300, 1500)
			};
			const t = randomTransform();
			for (const partially of [true, false]) {
				for (const excludeNonSelectable of [true, false]) {
					const a = getNodesInside(
						ours,
						rect,
						t,
						partially,
						excludeNonSelectable
					).map((n) => n.id);
					const b = rfGetNodesInside(
						ref as never,
						rect,
						t,
						partially,
						excludeNonSelectable
					).map((n) => n.id);
					expect(a).toEqual(b);
				}
			}
		}
	});
});

describe("parité interpolation", () => {
	it("cubicInOut = d3 easeCubicInOut", () => {
		for (let i = 0; i <= 1000; i++) {
			const t = i / 1000;
			expect(cubicInOut(t)).toBeCloseTo(easeCubicInOut(t), 14);
		}
	});

	it("interpolateZoom = d3 interpolateZoom", () => {
		for (let i = 0; i < 500; i++) {
			const a: View = [
				between(-5000, 5000),
				between(-5000, 5000),
				between(50, 50000)
			];
			const b: View =
				rand() > 0.9
					? [a[0], a[1], between(50, 50000)]
					: [between(-5000, 5000), between(-5000, 5000), between(50, 50000)];
			const ours = interpolateZoom(a, b);
			const ref = d3InterpolateZoom(a, b);
			for (const t of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
				const o = ours(t);
				const r = ref(t);
				expect(o[0]).toBeCloseTo(r[0], 6);
				expect(o[1]).toBeCloseTo(r[1], 6);
				expect(o[2] / r[2]).toBeCloseTo(1, 9);
			}
		}
	});
});

describe("parité applyNodeChanges", () => {
	it("même résultat que React Flow sur un mélange de changes", () => {
		const nodes: Node[] = Array.from({ length: 30 }, (_, i) => ({
			id: `n${i}`,
			position: { x: i * 10, y: i * 5 },
			data: { i }
		}));
		for (let round = 0; round < 200; round++) {
			const changes: NodeChange[] = [];
			for (let k = 0; k < 12; k++) {
				const id = `n${Math.floor(between(0, 30))}`;
				const r = rand();
				if (r < 0.2)
					changes.push({ id, type: "select", selected: rand() > 0.5 });
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
						item: {
							id: `new${round}-${k}`,
							position: { x: 0, y: 0 },
							data: {}
						},
						...(rand() > 0.5 ? { index: Math.floor(between(0, 10)) } : {})
					});
			}
			expect(applyNodeChanges(changes, nodes)).toEqual(
				rfApplyNodeChanges(changes as never, nodes as never)
			);
		}
	});
});

const POSITIONS = [
	Position.Left,
	Position.Top,
	Position.Right,
	Position.Bottom
];
const pick = <T>(items: T[]): T =>
	items[Math.floor(rand() * items.length)] as T;

describe("parité edges", () => {
	it("getSmoothStepPath = getSmoothStepPath RF (16 combinaisons de côtés)", () => {
		for (let i = 0; i < 4000; i++) {
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
			const params = {
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
			expect(getSmoothStepPath(params)).toEqual(
				rfGetSmoothStepPath(params as never)
			);
		}
	});

	const randomHandles = (
		nodeId: string,
		type: "source" | "target",
		w: number,
		h: number
	): HandleBound[] | null => {
		if (rand() < 0.05) return null;
		return POSITIONS.map((position) => ({
			id: rand() < 0.1 ? null : position,
			type,
			nodeId,
			position,
			x:
				position === Position.Left
					? -3
					: position === Position.Right
						? w - 3
						: w / 2 - 3,
			y:
				position === Position.Top
					? -3
					: position === Position.Bottom
						? h - 3
						: h / 2 - 3,
			width: 6,
			height: 6
		}));
	};

	const randomInternalNode = (id: string): InternalNode => {
		const w = between(40, 600);
		const h = between(40, 900);
		const pos = { x: between(-4000, 4000), y: between(-3000, 3000) };
		const user: Node = {
			id,
			position: pos,
			data: {},
			...(rand() < 0.1 ? { parentId: "p" } : {}),
			...(rand() < 0.3 ? { selected: true } : {})
		};
		const measuredOnce = rand() > 0.05;
		return {
			...user,
			measured: measuredOnce ? { width: w, height: h } : {},
			internals: {
				positionAbsolute: pos,
				z: Math.floor(between(0, 2000)),
				userNode: user,
				...(measuredOnce
					? {
							measuredOnce: true as const,
							handleBounds: {
								source: randomHandles(id, "source", w, h),
								target: randomHandles(id, "target", w, h)
							}
						}
					: {})
			}
		};
	};

	it("getEdgePosition / z-index / visibilité = React Flow", () => {
		for (let i = 0; i < 3000; i++) {
			const sourceNode = randomInternalNode("s");
			const targetNode = randomInternalNode("t");
			const sourceHandle = rand() < 0.2 ? null : pick([...POSITIONS, "x"]);
			const targetHandle = rand() < 0.2 ? null : pick([...POSITIONS, "x"]);
			expect(
				getEdgePosition(sourceNode, targetNode, sourceHandle, targetHandle)
			).toEqual(
				rfGetEdgePosition({
					id: "e",
					sourceNode: sourceNode as never,
					targetNode: targetNode as never,
					sourceHandle,
					targetHandle,
					connectionMode: ConnectionMode.Strict
				})
			);
			const zArgs = {
				sourceNode,
				targetNode,
				selected: rand() < 0.5,
				zIndex: rand() < 0.5 ? Math.floor(between(0, 20)) : undefined,
				elevateOnSelect: rand() < 0.5
			};
			expect(elevatedEdgeZIndex(zArgs)).toBe(
				rfGetElevatedEdgeZIndex(zArgs as never)
			);
			const view = {
				sourceNode,
				targetNode,
				width: between(200, 3000),
				height: between(200, 2000),
				transform: randomTransform()
			};
			expect(isEdgeVisible(view)).toBe(rfIsEdgeVisible(view as never));
		}
	});

	it("ids et définitions des markers = React Flow", () => {
		const markers = [
			{ type: MarkerType.ArrowClosed, width: 14, height: 14 },
			{ type: MarkerType.Arrow },
			{ type: MarkerType.ArrowClosed, color: "#f00", strokeWidth: 2 },
			{ type: MarkerType.Arrow, orient: "auto", markerUnits: "userSpaceOnUse" }
		];
		const edges: Edge[] = Array.from({ length: 40 }, (_, i) => ({
			id: `e${i}`,
			source: "a",
			target: "b",
			...(rand() < 0.8 ? { markerEnd: pick(markers) } : {}),
			...(rand() < 0.3 ? { markerStart: pick(markers) } : {}),
			...(rand() < 0.05 ? { markerEnd: "custom-id" } : {})
		}));
		for (const marker of [...markers, "custom-id", undefined]) {
			expect(getMarkerId(marker, "1")).toBe(
				rfGetMarkerId(marker as never, "1")
			);
		}
		expect(createMarkerIds(edges, "7", "#b1b1b7")).toEqual(
			rfCreateMarkerIds(edges as never, { id: "7", defaultColor: "#b1b1b7" })
		);
	});
});
