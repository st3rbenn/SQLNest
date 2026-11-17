import { describe, expect, it } from "vitest";
import { revealViewport } from "./revealViewport";

// Canvas de 1000 × 800, bandes de 100 px à gauche et en bas : avec la marge
// de 20, la zone libre va de 120 à 980 en largeur, de 20 à 680 en hauteur.
const container = { width: 1000, height: 800 };
const safeArea = { left: 100, right: 0, top: 0, bottom: 100 };
const view = { x: 0, y: 0, zoom: 1 };
const reveal = (rect: {
	x: number;
	y: number;
	width: number;
	height: number;
}) => revealViewport(view, rect, container, safeArea, 20);

describe("revealViewport", () => {
	it("ne bouge pas pour un frame déjà visible en entier", () => {
		expect(reveal({ x: 200, y: 100, width: 300, height: 200 })).toBeNull();
	});

	it("ramène un frame qui dépasse à droite, juste ce qu'il faut", () => {
		expect(reveal({ x: 900, y: 100, width: 300, height: 200 })).toEqual({
			x: -220,
			y: 0,
			zoom: 1
		});
	});

	it("ramène un frame qui dépasse en haut et à gauche", () => {
		expect(reveal({ x: 50, y: -90, width: 300, height: 200 })).toEqual({
			x: 70,
			y: 110,
			zoom: 1
		});
	});

	it("compte la bande occupée en bas", () => {
		expect(reveal({ x: 200, y: 600, width: 300, height: 200 })).toEqual({
			x: 0,
			y: -120,
			zoom: 1
		});
	});

	it("tient compte du zoom sans le changer", () => {
		const to = revealViewport(
			{ x: 0, y: 0, zoom: 0.5 },
			{ x: 1900, y: 100, width: 400, height: 200 },
			container,
			safeArea,
			20
		);
		expect(to).toEqual({ x: -170, y: 0, zoom: 0.5 });
	});

	it("montre le début d'un frame plus grand que la zone libre", () => {
		expect(reveal({ x: 500, y: 300, width: 2000, height: 100 })).toEqual({
			x: -380,
			y: 0,
			zoom: 1
		});
	});

	it("laisse la vue quand un frame plus grand couvre déjà la zone", () => {
		expect(reveal({ x: 0, y: -100, width: 2000, height: 2000 })).toBeNull();
	});
});
