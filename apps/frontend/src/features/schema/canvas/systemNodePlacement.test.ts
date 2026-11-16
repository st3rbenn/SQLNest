import { describe, expect, it } from "vitest";
import { placeBesideContent, type Rect } from "./systemNodePlacement";

const tables: Rect[] = [
	{ x: 0, y: 0, width: 240, height: 120 },
	{ x: 300, y: -80, width: 240, height: 200 },
	{ x: -100, y: 400, width: 240, height: 90 }
];
const size = { width: 280, height: 185 };

const overlaps = (a: Rect, b: Rect) =>
	a.x < b.x + b.width &&
	b.x < a.x + a.width &&
	a.y < b.y + b.height &&
	b.y < a.y + a.height;

describe("placeBesideContent", () => {
	it("canvas vide : pas de place à chercher", () => {
		expect(placeBesideContent([], [], size)).toBe(null);
	});

	it("à gauche de tout le contenu, en haut", () => {
		const spot = placeBesideContent(tables, [], size);
		expect(spot).toEqual({ x: -100 - 60 - 280, y: -80 });
	});

	it("ne recouvre aucune table ni aucun frame", () => {
		const spot = placeBesideContent(tables, [], size) as {
			x: number;
			y: number;
		};
		const rect = { ...spot, ...size };
		expect(tables.some((t) => overlaps(t, rect))).toBe(false);
	});

	it("descend sous un node système déjà dans la colonne", () => {
		const first = placeBesideContent(tables, [], size) as {
			x: number;
			y: number;
		};
		const second = placeBesideContent(tables, [{ ...first, ...size }], {
			width: 260,
			height: 190
		});
		expect(second).toEqual({ x: -100 - 60 - 260, y: -80 + 185 + 60 });
	});

	it("un node système posé ailleurs ne le déplace pas", () => {
		const elsewhere = { x: 900, y: 900, width: 280, height: 185 };
		expect(placeBesideContent(tables, [elsewhere], size)).toEqual({
			x: -440,
			y: -80
		});
	});
});
