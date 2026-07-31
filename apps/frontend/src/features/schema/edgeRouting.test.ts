import { describe, expect, it } from "vitest";
import { bestHandles, type Rect } from "./edgeRouting";

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
