import type { NodeChange } from "@sqlnest/canvas";
import { describe, expect, it } from "vitest";
import type { Frame } from "../frames";
import type { TableNodeType } from "../TableNode";
import {
	applyCanvasChanges,
	canReparentNode,
	deepestFrameContaining,
	fitLegacyFrames,
	frameDescendants,
	frameRectsFromContent,
	growFramesToContain,
	growRectToContain,
	normalizeFrames,
	withFrameParents
} from "./frameTree";

const table = (id: string, x: number, y: number): TableNodeType =>
	({
		id,
		type: "table",
		position: { x, y },
		width: 200,
		height: 100,
		data: {
			collection: { name: id, fields: [] },
			dimmed: false,
			focused: false,
			matched: false
		}
	}) as unknown as TableNodeType;

const frame = (
	key: string,
	rect: { x: number; y: number; width: number; height: number },
	collections: string[] = [],
	parentKey?: string
): Frame => ({
	key,
	label: key,
	hue: 210,
	collections,
	rect,
	...(parentKey ? { parentKey } : {})
});

// outer (0,0) ⊃ inner (100,100) ⊃ t1 (150,150) ; outer ⊃ t2 (500,50) ; t3 racine.
const frames: Frame[] = [
	frame("outer", { x: 0, y: 0, width: 800, height: 600 }, ["t2"]),
	frame("inner", { x: 100, y: 100, width: 300, height: 300 }, ["t1"], "outer")
];
const tables = [
	table("t1", 150, 150),
	table("t2", 500, 50),
	table("t3", 1000, 0)
];

const positions = (changes: NodeChange<TableNodeType>[]) =>
	Object.fromEntries(
		changes
			.filter((c) => c.type === "position")
			.map((c) => [
				(c as { id: string }).id,
				(c as { position: unknown }).position
			])
	);

describe("vers le repère du moteur", () => {
	it("tables dans leur frame : parentId et position relative", () => {
		const out = withFrameParents(tables, frames);
		expect(out[0]).toMatchObject({
			parentId: "frame:inner",
			expandParent: true,
			position: { x: 50, y: 50 }
		});
		expect(out[1]).toMatchObject({
			parentId: "frame:outer",
			position: { x: 500, y: 50 }
		});
		expect(out[2]).toBe(tables[2]);
	});

	it("même table, frame immobile : même objet ; frame déplacé : recalculé", () => {
		const first = withFrameParents(tables, frames);
		expect(withFrameParents(tables, frames)[0]).toBe(first[0]);
		const moved = frames.map((f) =>
			f.key === "inner" && f.rect ? { ...f, rect: { ...f.rect, x: 120 } } : f
		);
		const next = withFrameParents(tables, moved);
		expect(next[0]).not.toBe(first[0]);
		expect(next[0]?.position).toEqual({ x: 30, y: 50 });
	});

	it("parent absent ou cycle : frame racine", () => {
		const broken = normalizeFrames([
			frame("a", { x: 0, y: 0, width: 10, height: 10 }, [], "b"),
			frame("b", { x: 0, y: 0, width: 10, height: 10 }, [], "a"),
			frame("c", { x: 0, y: 0, width: 10, height: 10 }, [], "ghost"),
			frame("d", { x: 0, y: 0, width: 10, height: 10 }, [], "c")
		]);
		// a ↔ b : le premier lien du cycle est coupé ; c → fantôme : coupé ;
		// d garde son parent c.
		expect(broken.map((f) => f.parentKey)).toEqual([
			undefined,
			"a",
			undefined,
			"c"
		]);
	});

	it("seuls tables et frames rejoignent un frame", () => {
		const n = (type: string) =>
			({ id: type, type, position: { x: 0, y: 0 }, data: {} }) as never;
		expect(canReparentNode(n("table"), n("frame"))).toBe(true);
		expect(canReparentNode(n("frame"), null)).toBe(true);
		expect(canReparentNode(n("console"), n("frame"))).toBe(false);
		expect(canReparentNode(n("table"), n("table"))).toBe(false);
	});
});

describe("changes du moteur ramenés en absolu", () => {
	it("glisser un frame déplace tout son contenu, à toutes profondeurs", () => {
		const {
			frames: next,
			tableChanges,
			moved
		} = applyCanvasChanges(
			[
				{
					id: "frame:outer",
					type: "position",
					position: { x: 30, y: 20 },
					dragging: true
				}
			],
			frames,
			tables
		);
		expect(next.find((f) => f.key === "outer")?.rect).toMatchObject({
			x: 30,
			y: 20
		});
		expect(next.find((f) => f.key === "inner")?.rect).toMatchObject({
			x: 130,
			y: 120
		});
		expect(positions(tableChanges)).toEqual({
			t1: { x: 180, y: 170 },
			t2: { x: 530, y: 70 }
		});
		expect([...moved.keys()].sort()).toEqual(["t1", "t2"]);
	});

	it("table glissée dans son frame : position relative → absolue", () => {
		const { tableChanges } = applyCanvasChanges(
			[
				{
					id: "t1",
					type: "position",
					position: { x: 60, y: 70 },
					dragging: false
				}
			],
			frames,
			tables
		);
		expect(tableChanges).toContainEqual({
			id: "t1",
			type: "position",
			position: { x: 160, y: 170 },
			dragging: false
		});
	});

	it("resize par le coin haut-gauche : les enfants restent en place", () => {
		// Le moteur déplace le frame de -50 et compense ses enfants de +50.
		const { frames: next, tableChanges } = applyCanvasChanges(
			[
				{ id: "frame:inner", type: "position", position: { x: 50, y: 50 } },
				{
					id: "frame:inner",
					type: "dimensions",
					resizing: true,
					setAttributes: true,
					dimensions: { width: 350, height: 350 }
				},
				{ id: "t1", type: "position", position: { x: 100, y: 100 } }
			],
			frames,
			tables
		);
		expect(next.find((f) => f.key === "inner")?.rect).toEqual({
			x: 50,
			y: 50,
			width: 350,
			height: 350
		});
		expect(positions(tableChanges).t1).toEqual({ x: 150, y: 150 });
	});

	it("agrandissement vers la gauche : le frame bouge, les voisins non", () => {
		// t1 poussée à gauche d'inner : inner recule de 80, t1 en 0, voisin
		// éventuel compensé — ici t1 est seule, inner grandit.
		const { frames: next, tableChanges } = applyCanvasChanges(
			[
				{
					id: "t1",
					type: "position",
					position: { x: 0, y: 50 },
					dragging: true
				},
				{ id: "frame:inner", type: "position", position: { x: 20, y: 100 } },
				{
					id: "frame:inner",
					type: "dimensions",
					setAttributes: true,
					dimensions: { width: 380, height: 300 }
				}
			],
			frames,
			tables
		);
		expect(next.find((f) => f.key === "inner")?.rect).toEqual({
			x: 20,
			y: 100,
			width: 380,
			height: 300
		});
		expect(positions(tableChanges).t1).toEqual({ x: 20, y: 150 });
	});

	it("mesure DOM d'un frame (sans resizing) : ignorée", () => {
		const out = applyCanvasChanges(
			[
				{
					id: "frame:outer",
					type: "dimensions",
					dimensions: { width: 1, height: 1 }
				}
			],
			frames,
			tables
		);
		expect(out.frames).toBe(frames);
		expect(out.tableChanges).toHaveLength(0);
	});

	it("table qui change de frame : appartenance mise à jour, aucun saut", () => {
		const { frames: next, tableChanges } = applyCanvasChanges(
			[
				{
					id: "t3",
					type: "parent",
					parentId: "frame:inner",
					position: { x: 10, y: 20 },
					dragging: true
				}
			],
			frames,
			tables
		);
		expect(next.find((f) => f.key === "inner")?.collections).toEqual([
			"t1",
			"t3"
		]);
		expect(positions(tableChanges).t3).toEqual({ x: 110, y: 120 });
	});

	it("table sortie de tout frame : retirée, position absolue", () => {
		const { frames: next, tableChanges } = applyCanvasChanges(
			[
				{
					id: "t1",
					type: "parent",
					parentId: null,
					position: { x: 900, y: 700 }
				}
			],
			frames,
			tables
		);
		expect(next.find((f) => f.key === "inner")?.collections).toEqual([]);
		expect(positions(tableChanges).t1).toEqual({ x: 900, y: 700 });
	});

	it("frame rangé dans un autre : parentKey, contenu emmené sans saut", () => {
		const withLoose = [
			...frames,
			frame("loose", { x: 1000, y: 0, width: 300, height: 300 }, ["t3"])
		];
		const { frames: next, tableChanges } = applyCanvasChanges(
			[
				{
					id: "frame:loose",
					type: "parent",
					parentId: "frame:outer",
					position: { x: 400, y: 300 }
				}
			],
			withLoose,
			tables
		);
		const loose = next.find((f) => f.key === "loose");
		expect(loose?.parentKey).toBe("outer");
		expect(loose?.rect).toMatchObject({ x: 400, y: 300 });
		// t3 garde sa place dans `loose` : (0, 0) relatif.
		expect(positions(tableChanges).t3).toEqual({ x: 400, y: 300 });
	});

	it("frame sorti à la racine : parentKey retiré", () => {
		const { frames: next } = applyCanvasChanges(
			[
				{
					id: "frame:inner",
					type: "parent",
					parentId: null,
					position: { x: 900, y: 900 }
				}
			],
			frames,
			tables
		);
		expect(next.find((f) => f.key === "inner")?.parentKey).toBeUndefined();
	});

	it("changes d'autres nodes (consoles) transmis tels quels", () => {
		const change: NodeChange<TableNodeType> = {
			id: "console:x",
			type: "position",
			position: { x: 1, y: 1 }
		};
		const out = applyCanvasChanges([change], frames, tables);
		expect(out.tableChanges).toEqual([change]);
	});
});

describe("géométrie des frames", () => {
	it("descendants d'un frame", () => {
		const d = frameDescendants(frames, "outer");
		expect([...d.frames]).toEqual(["inner"]);
		expect([...d.tables].sort()).toEqual(["t1", "t2"]);
	});

	it("le frame le plus profond qui contient un rect", () => {
		expect(
			deepestFrameContaining(frames, { x: 120, y: 120, width: 50, height: 50 })
				?.key
		).toBe("inner");
		expect(
			deepestFrameContaining(frames, { x: 450, y: 10, width: 50, height: 50 })
				?.key
		).toBe("outer");
		expect(
			deepestFrameContaining(frames, {
				x: 750,
				y: 550,
				width: 100,
				height: 100
			})
		).toBeNull();
	});

	it("un frame grandit pour contenir un rect, ses ancêtres aussi", () => {
		const next = growFramesToContain(
			frames,
			"inner",
			{ x: 700, y: 500, width: 200, height: 200 },
			24
		);
		expect(next.find((f) => f.key === "inner")?.rect).toEqual({
			x: 100,
			y: 100,
			width: 824,
			height: 624
		});
		expect(next.find((f) => f.key === "outer")?.rect).toEqual({
			x: 0,
			y: 0,
			width: 948,
			height: 748
		});
	});

	it("lasso : agrandi pour une table qui dépasse, inchangé sinon", () => {
		const drawn = { x: 0, y: 0, width: 300, height: 200 };
		const inside = { x: 10, y: 10, width: 100, height: 50 };
		expect(growRectToContain(drawn, [inside], 24)).toBe(drawn);
		expect(
			growRectToContain(
				drawn,
				[inside, { x: 250, y: 150, width: 200, height: 100 }],
				24
			)
		).toEqual({ x: 0, y: 0, width: 474, height: 274 });
	});

	it("déjà contenu : rien ne change", () => {
		expect(
			growFramesToContain(
				frames,
				"inner",
				{ x: 150, y: 150, width: 10, height: 10 },
				24
			)
		).toBe(frames);
	});

	it("frame d'avant le rognage : grandit pour son membre qui dépasse, puis marqué", () => {
		// t3 (1000, 0) membre de `legacy` mais hors de son rect.
		const legacy = frame(
			"legacy",
			{ x: 900, y: 200, width: 400, height: 300 },
			["t3"]
		);
		const [next] = fitLegacyFrames([legacy], tables, 24);
		expect(next?.rect).toEqual({ x: 900, y: -24, width: 400, height: 524 });
		expect(next?.clips).toBe(true);
	});

	it("membres déjà dedans : seulement marqué ; frame marqué : jamais regrandi", () => {
		const inside = fitLegacyFrames(frames, tables, 24);
		expect(inside.map((f) => f.rect)).toEqual(frames.map((f) => f.rect));
		expect(inside.every((f) => f.clips)).toBe(true);
		// Rétréci volontairement après coup : ce qui dépasse reste rogné.
		const shrunk = inside.map((f) =>
			f.key === "inner" && f.rect
				? { ...f, rect: { ...f.rect, width: 20, height: 20 } }
				: f
		);
		expect(fitLegacyFrames(shrunk, tables, 24)).toBe(shrunk);
	});

	it("auto-layout : rects recalculés de bas en haut", () => {
		const next = frameRectsFromContent(frames, tables, 10);
		expect(next.find((f) => f.key === "inner")?.rect).toEqual({
			x: 140,
			y: 140,
			width: 220,
			height: 120
		});
		// outer englobe t2 et le nouveau rect d'inner.
		expect(next.find((f) => f.key === "outer")?.rect).toEqual({
			x: 130,
			y: 40,
			width: 580,
			height: 230
		});
	});
});
