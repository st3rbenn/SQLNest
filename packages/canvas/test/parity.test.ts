/**
 * Parité avec React Flow sur les fonctions pures (ADR-033). Les sorties de
 * référence ont été calculées par `@xyflow/system` 0.0.79 / `@xyflow/react`
 * 12.11.2 sur les entrées de `parityInputs()` puis figées dans
 * `fixtures/parity.json` au retrait de React Flow. L'interpolation reste
 * comparée en direct à d3.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
import { handlePosition } from "../src/handles";
import { applyNodeChanges } from "../src/hooks";
import { cubicInOut, interpolateZoom, type View } from "../src/interpolate";
import { getBezierPath, getSmoothStepPath } from "../src/paths";
import { Position } from "../src/types";
import { parityInputs } from "./parityInputs";

// Lu tel quel : l'import JSON de Vite arrondit certains flottants au
// dernier chiffre, ce qui casserait la comparaison exacte.
const fixtures = JSON.parse(
	readFileSync(
		join(dirname(fileURLToPath(import.meta.url)), "fixtures/parity.json"),
		"utf8"
	)
);
const inputs = parityInputs();

describe("parité géométrie", () => {
	it("viewportForBounds = getViewportForBounds", () => {
		inputs.viewportForBounds.forEach((c, i) => {
			const [x, y, zoom] = fixtures.viewportForBounds[i] as number[];
			const ours = viewportForBounds(
				c.bounds,
				c.width,
				c.height,
				c.minZoom,
				c.maxZoom,
				c.padding
			);
			expect(ours.x).toBeCloseTo(x as number, 9);
			expect(ours.y).toBeCloseTo(y as number, 9);
			expect(ours.zoom).toBeCloseTo(zoom as number, 12);
		});
	});

	it("pointToFlow / flowToPoint = pointToRendererPoint / rendererPointToPoint", () => {
		inputs.points.forEach((c, i) => {
			const [fx, fy, sx, sy] = fixtures.points[i] as number[];
			expect(pointToFlow(c.point, c.transform)).toEqual({ x: fx, y: fy });
			expect(flowToPoint(c.point, c.transform)).toEqual({ x: sx, y: sy });
		});
	});

	it("autoPan = calcAutoPan", () => {
		inputs.autoPan.forEach((c, i) => {
			const [rx, ry] = fixtures.autoPan[i] as number[];
			const [ox, oy] = autoPan(c.pos, c.bounds);
			expect(ox).toBeCloseTo(rx as number, 12);
			expect(oy).toBeCloseTo(ry as number, 12);
		});
	});

	it("getNodesInside (partiel et total) = getNodesInside RF", () => {
		inputs.nodesInside.forEach((c, i) => {
			const expected = fixtures.nodesInside[i] as string[][];
			let k = 0;
			for (const partially of [true, false]) {
				for (const excludeNonSelectable of [true, false]) {
					expect(
						getNodesInside(
							c.nodes,
							c.rect,
							c.transform,
							partially,
							excludeNonSelectable
						).map((n) => n.id)
					).toEqual(expected[k]);
					k += 1;
				}
			}
		});
	});

	it("handlePosition = getHandlePosition RF (côté et centre)", () => {
		inputs.handlePosition.forEach((c, i) => {
			const [x, y] = fixtures.handlePosition[i] as number[];
			expect(handlePosition(c.node, c.handle, Position.Left, c.center)).toEqual(
				{ x, y }
			);
		});
	});
});

describe("parité tracés", () => {
	it("getBezierPath = getBezierPath RF", () => {
		inputs.bezier.forEach((p, i) => {
			expect(getBezierPath(p)).toEqual(fixtures.bezier[i]);
		});
	});

	it("getSmoothStepPath = getSmoothStepPath RF (16 combinaisons de côtés)", () => {
		const combos = new Set(
			inputs.smoothStep.map((p) => `${p.sourcePosition}-${p.targetPosition}`)
		);
		expect(combos.size).toBe(16);
		inputs.smoothStep.forEach((p, i) => {
			expect(getSmoothStepPath(p)).toEqual(fixtures.smoothStep[i]);
		});
	});
});

describe("parité edges", () => {
	it("getEdgePosition / z-index / visibilité = React Flow", () => {
		inputs.edges.forEach((c, i) => {
			const [position, zIndex, visible] = fixtures.edges[i] as [
				unknown,
				number,
				boolean
			];
			expect(
				getEdgePosition(
					c.sourceNode,
					c.targetNode,
					c.sourceHandle,
					c.targetHandle
				)
			).toEqual(position);
			expect(
				elevatedEdgeZIndex({
					sourceNode: c.sourceNode,
					targetNode: c.targetNode,
					...c.z
				})
			).toBe(zIndex);
			expect(
				isEdgeVisible({
					sourceNode: c.sourceNode,
					targetNode: c.targetNode,
					...c.view
				})
			).toBe(visible);
		});
	});

	it("ids et définitions des markers = React Flow", () => {
		inputs.markers.ids.forEach((m, i) => {
			expect(getMarkerId(m, "1")).toBe(fixtures.markers.ids[i]);
		});
		expect(createMarkerIds(inputs.markers.edges, "7", "#b1b1b7")).toEqual(
			fixtures.markers.created
		);
	});
});

describe("parité applyNodeChanges", () => {
	it("même résultat que React Flow sur un mélange de changes", () => {
		inputs.applyNodeChanges.forEach((changes, i) => {
			expect(
				applyNodeChanges(changes, structuredClone(inputs.baseNodes))
			).toEqual(fixtures.applyNodeChanges[i]);
		});
	});
});

function rng(seed: number) {
	let s = seed >>> 0;
	return () => {
		s = (s * 1664525 + 1013904223) >>> 0;
		return s / 2 ** 32;
	};
}

describe("parité interpolation (d3 en direct)", () => {
	const rand = rng(42);
	const between = (min: number, max: number) => min + rand() * (max - min);

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
