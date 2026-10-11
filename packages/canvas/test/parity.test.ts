/**
 * Parité avec React Flow sur les fonctions pures, tant que RF reste installé
 * en référence (ADR-033). Entrées pseudo-aléatoires à graine fixe.
 */
import { applyNodeChanges as rfApplyNodeChanges } from "@xyflow/react";
import {
	calcAutoPan,
	getViewportForBounds,
	pointToRendererPoint,
	rendererPointToPoint,
	getNodesInside as rfGetNodesInside
} from "@xyflow/system";
import { easeCubicInOut } from "d3-ease";
import { interpolateZoom as d3InterpolateZoom } from "d3-interpolate";
import { describe, expect, it } from "vitest";
import {
	autoPan,
	flowToPoint,
	getNodesInside,
	pointToFlow,
	viewportForBounds
} from "../src/geometry";
import { applyNodeChanges } from "../src/hooks";
import { cubicInOut, interpolateZoom, type View } from "../src/interpolate";
import type { InternalNode, Node, NodeChange, Transform } from "../src/types";

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
