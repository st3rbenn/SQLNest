import { describe, expect, it } from "vitest";
import {
	bestHandles,
	closestSide,
	type Rect,
	spreadOffsets
} from "./edgeRouting";

const rect = (x: number, y: number, width = 200, height = 100): Rect => ({
	x,
	y,
	width,
	height
});

describe("bestHandles", () => {
	it("target à droite dominant → source.right / target.left", () => {
		expect(bestHandles(rect(0, 0), rect(500, 50))).toEqual({
			source: "right",
			target: "left"
		});
	});

	it("target à gauche dominant → source.left / target.right", () => {
		expect(bestHandles(rect(500, 0), rect(0, 50))).toEqual({
			source: "left",
			target: "right"
		});
	});

	it("target en dessous dominant → source.bottom / target.top", () => {
		expect(bestHandles(rect(0, 0), rect(50, 500))).toEqual({
			source: "bottom",
			target: "top"
		});
	});

	it("target au-dessus dominant → source.top / target.bottom", () => {
		expect(bestHandles(rect(0, 500), rect(50, 0))).toEqual({
			source: "top",
			target: "bottom"
		});
	});

	it("horizontal égalité (|dx| == |dy|) → horizontal gagne", () => {
		expect(bestHandles(rect(0, 0), rect(100, 100))).toEqual({
			source: "right",
			target: "left"
		});
	});

	it("compense la taille via le centre du rect (pas le coin)", () => {
		// source (0,0, 200×100) centre = (100, 50)
		// target (300, 0, 200×100) centre = (400, 50)
		// dx = 300, dy = 0 → horizontal droite
		expect(bestHandles(rect(0, 0), rect(300, 0))).toEqual({
			source: "right",
			target: "left"
		});
	});

	it("routage diagonal : légère dominance verticale bascule sur vertical", () => {
		// dx = 100, dy = 150 → |dy| > |dx| → vertical, target en dessous
		expect(bestHandles(rect(0, 0, 100, 100), rect(100, 150, 100, 100))).toEqual(
			{
				source: "bottom",
				target: "top"
			}
		);
	});
});

describe("closestSide", () => {
	const r = rect(100, 100, 200, 100); // top=100 right=300 bottom=200 left=100

	it("point au-dessus → top", () => {
		expect(closestSide({ x: 200, y: 20 }, r)).toBe("top");
	});

	it("point à droite → right", () => {
		expect(closestSide({ x: 400, y: 150 }, r)).toBe("right");
	});

	it("point en dessous → bottom", () => {
		expect(closestSide({ x: 200, y: 300 }, r)).toBe("bottom");
	});

	it("point à gauche → left", () => {
		expect(closestSide({ x: 20, y: 150 }, r)).toBe("left");
	});

	it("point au centre du rect → l'un des 4 côtés (déterministe)", () => {
		// Au centre exact, les 4 mid-sides sont équidistants. Le premier
		// (top) gagne par ordre d'itération.
		expect(closestSide({ x: 200, y: 150 }, r)).toBe("top");
	});

	it("point loin en diagonale haut-droite → chosit selon le mid-side le plus proche", () => {
		// Point (500, 20). midTop=(200, 100), midRight=(300, 150).
		// dTop² = 300² + 80² = 90000 + 6400 = 96400
		// dRight² = 200² + 130² = 40000 + 16900 = 56900 ← plus petit
		expect(closestSide({ x: 500, y: 20 }, r)).toBe("right");
	});
});

describe("spreadOffsets", () => {
	it("n=0 → []", () => {
		expect(spreadOffsets(0)).toEqual([]);
	});

	it("n=1 → [0] (mid, aucun spread)", () => {
		expect(spreadOffsets(1)).toEqual([0]);
	});

	it("n=2 → [-0.1, 0.1] (pas fixe 0.2, grappe serrée)", () => {
		const r = spreadOffsets(2);
		expect(r[0]).toBeCloseTo(-0.1, 5);
		expect(r[1]).toBeCloseTo(0.1, 5);
	});

	it("n=3 → [-0.2, 0, 0.2]", () => {
		const r = spreadOffsets(3);
		expect(r[0]).toBeCloseTo(-0.2, 5);
		expect(r[1]).toBeCloseTo(0, 5);
		expect(r[2]).toBeCloseTo(0.2, 5);
	});

	it("n=5 atteint le plafond ±0.4 (pas 0.2 × 4 slots = 0.8 = 2×CAP)", () => {
		const r = spreadOffsets(5);
		expect(r[0]).toBeCloseTo(-0.4, 5);
		expect(r[1]).toBeCloseTo(-0.2, 5);
		expect(r[2]).toBeCloseTo(0, 5);
		expect(r[3]).toBeCloseTo(0.2, 5);
		expect(r[4]).toBeCloseTo(0.4, 5);
	});

	it("n>5 : cluster resserré dans [-0.4, 0.4]", () => {
		const r = spreadOffsets(10);
		expect(r).toHaveLength(10);
		for (const v of r) {
			expect(v).toBeGreaterThanOrEqual(-0.4);
			expect(v).toBeLessThanOrEqual(0.4);
		}
		expect(r[0]).toBeCloseTo(-0.4, 5);
		expect(r[9]).toBeCloseTo(0.4, 5);
	});

	it("symétrique autour de 0 pour n impair", () => {
		const r = spreadOffsets(5);
		expect(r[0]).toBeCloseTo(-r[4]!, 5);
		expect(r[1]).toBeCloseTo(-r[3]!, 5);
		expect(r[2]).toBe(0);
	});
});
