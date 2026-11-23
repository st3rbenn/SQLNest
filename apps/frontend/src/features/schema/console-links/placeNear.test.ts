import { describe, expect, it } from "vitest";
import { placeAt, placeNear, type Rect } from "./placeNear";

const anchor: Rect = { x: 100, y: 100, width: 200, height: 100 };
const size = { width: 300, height: 150 };
const options = {
	gap: 20,
	clearance: 10,
	prefer: ["below", "right", "left", "above"] as const
};

describe("placeNear", () => {
	it("colle le frame au côté préféré quand rien ne gêne", () => {
		expect(placeNear(anchor, size, [], options)).toEqual({ x: 100, y: 220 });
	});

	it("change de côté quand le préféré est pris", () => {
		// Occupe le dessous sans déborder sous la place de droite.
		const below: Rect = { x: 0, y: 210, width: 310, height: 2000 };
		expect(placeNear(anchor, size, [below], options)).toEqual({
			x: 320,
			y: 100
		});
	});

	it("saute par-dessus ce qui le gêne quand c'est le plus court", () => {
		// Dessous : un petit frame à enjamber (60 px de chemin). À droite, à
		// gauche et au-dessus : des murs.
		const small: Rect = { x: 100, y: 220, width: 300, height: 50 };
		const walls: Rect[] = [
			{ x: 320, y: -2000, width: 2000, height: 2200 },
			{ x: -3000, y: -2000, width: 3050, height: 2200 },
			{ x: -3000, y: -3000, width: 6000, height: 2900 }
		];
		expect(placeNear(anchor, size, [small, ...walls], options)).toEqual({
			x: 100,
			y: 280
		});
	});

	it("garde la marge avec ses voisins", () => {
		const near: Rect = { x: 405, y: 220, width: 100, height: 100 };
		// 5 px d'écart seulement avec le frame posé dessous : trop près.
		const placed = placeNear(anchor, size, [near], options);
		expect(placed).not.toEqual({ x: 100, y: 220 });
	});

	it("à chemin égal, garde l'ordre de préférence", () => {
		expect(
			placeNear(anchor, size, [], { ...options, prefer: ["right", "below"] })
		).toEqual({ x: 320, y: 100 });
	});

	it("centre le frame sous l'ancre quand on le lui demande", () => {
		// Ancre large de 200, frame large de 300 : il déborde de 50 de chaque côté.
		expect(
			placeNear(anchor, size, [], { ...options, align: "center" })
		).toEqual({ x: 50, y: 220 });
	});

	it("retombe sur le côté préféré si tout est pris", () => {
		const everything: Rect = {
			x: -100000,
			y: -100000,
			width: 200000,
			height: 200000
		};
		// Un mur infini se franchit d'un saut : la place trouvée est au-delà.
		const placed = placeNear(anchor, size, [everything], options);
		expect(placed.x === 100 || placed.y === 100).toBe(true);
	});
});

describe("placeAt", () => {
	const wanted = { x: 380, y: 350 };
	const card = { width: 240, height: 100 };
	const sides = {
		clearance: 24,
		prefer: ["right", "below", "left", "above"] as const
	};

	it("sur place quand rien ne gêne", () => {
		expect(placeAt(wanted, card, [], sides)).toEqual(wanted);
	});

	it("place prise : glissé du côté le plus court, pas du premier essayé", () => {
		expect(placeAt(wanted, card, [{ ...wanted, ...card }], sides)).toEqual({
			x: 380,
			y: 474
		});
	});
});
