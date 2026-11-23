import { describe, expect, it } from "vitest";
import { connectionAnchor } from "../src/handles";
import { type HandleBound, type InternalNode, Position } from "../src/types";

const node = {
	id: "t",
	position: { x: 100, y: 50 },
	internals: { positionAbsolute: { x: 100, y: 50 } }
} as unknown as InternalNode;

const row = (anchor?: "side"): HandleBound => ({
	id: "field:id",
	type: "target",
	nodeId: "t",
	position: Position.Left,
	x: 0,
	y: 40,
	width: 240,
	height: 20,
	...(anchor !== undefined ? { anchor } : {})
});

describe("connectionAnchor", () => {
	it("handle ordinaire : son centre, quelle que soit l'origine", () => {
		expect(connectionAnchor(node, row(), { x: -500, y: 0 })).toEqual({
			point: { x: 220, y: 100 },
			position: Position.Left
		});
	});

	it("handle ancré par le côté : le bord qui fait face à l'autre bout", () => {
		expect(connectionAnchor(node, row("side"), { x: -500, y: 0 })).toEqual({
			point: { x: 100, y: 100 },
			position: Position.Left
		});
		expect(connectionAnchor(node, row("side"), { x: 900, y: 300 })).toEqual({
			point: { x: 340, y: 100 },
			position: Position.Right
		});
	});
});
