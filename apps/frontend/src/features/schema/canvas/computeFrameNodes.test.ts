import { describe, expect, it } from "vitest";
import type { Frame } from "../frames";
import { computeFrameNodes } from "./computeFrameNodes";

const noop = () => {};
const frames: Frame[] = [
	{
		key: "outer",
		label: "outer",
		hue: 210,
		collections: [],
		rect: { x: 100, y: 50, width: 800, height: 600 }
	},
	{
		key: "inner",
		label: "inner",
		hue: 140,
		collections: [],
		rect: { x: 150, y: 120, width: 300, height: 200 },
		parentKey: "outer"
	}
];

describe("nodes frame", () => {
	it("taille du rect portée comme mesure : un resize part de la bonne taille", () => {
		const [outer] = computeFrameNodes(frames, [], noop, noop, noop, noop);
		expect(outer?.measured).toEqual({ width: 800, height: 600 });
	});

	it("frame imbriqué : parent, position relative, agrandit son parent", () => {
		const [, inner] = computeFrameNodes(frames, [], noop, noop, noop, noop);
		expect(inner).toMatchObject({
			parentId: "frame:outer",
			expandParent: true,
			clipChildren: true,
			position: { x: 50, y: 70 }
		});
	});
});
