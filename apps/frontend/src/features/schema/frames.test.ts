import { describe, expect, it } from "vitest";
import { type FrameRect, framesFor, rectContainsPoint } from "./frames";
import { SAMPLE_POSTGRES, type SchemaModel } from "./schema-model";

const rect: FrameRect = { x: 10, y: 20, width: 100, height: 50 };

function coll(name: string): SchemaModel["collections"][number] {
	return { name, fields: [], source: "declared" };
}

describe("rectContainsPoint", () => {
	it("returns true for a point strictly inside the rect", () => {
		expect(rectContainsPoint(rect, { x: 50, y: 40 })).toBe(true);
	});

	it("is inclusive on the four bounds", () => {
		// Top-left corner
		expect(rectContainsPoint(rect, { x: 10, y: 20 })).toBe(true);
		// Bottom-right corner
		expect(rectContainsPoint(rect, { x: 110, y: 70 })).toBe(true);
		// Left edge, right edge, top edge, bottom edge
		expect(rectContainsPoint(rect, { x: 10, y: 40 })).toBe(true);
		expect(rectContainsPoint(rect, { x: 110, y: 40 })).toBe(true);
		expect(rectContainsPoint(rect, { x: 50, y: 20 })).toBe(true);
		expect(rectContainsPoint(rect, { x: 50, y: 70 })).toBe(true);
	});

	it("returns false for a point just outside any bound", () => {
		expect(rectContainsPoint(rect, { x: 9, y: 40 })).toBe(false);
		expect(rectContainsPoint(rect, { x: 111, y: 40 })).toBe(false);
		expect(rectContainsPoint(rect, { x: 50, y: 19 })).toBe(false);
		expect(rectContainsPoint(rect, { x: 50, y: 71 })).toBe(false);
	});

	it("returns false for a point far outside", () => {
		expect(rectContainsPoint(rect, { x: -100, y: -100 })).toBe(false);
		expect(rectContainsPoint(rect, { x: 1000, y: 1000 })).toBe(false);
	});
});

describe("framesFor", () => {
	it("returns the two seed frames (users + commerce) for SAMPLE_POSTGRES", () => {
		const frames = framesFor(SAMPLE_POSTGRES);
		expect(frames.map((f) => f.key)).toEqual(["users", "commerce"]);
	});

	it("attaches only collections present in the schema to each frame", () => {
		const frames = framesFor(SAMPLE_POSTGRES);
		const users = frames.find((f) => f.key === "users");
		const commerce = frames.find((f) => f.key === "commerce");
		expect(users?.collections).toEqual(["users"]);
		// SAMPLE_POSTGRES has orders/products/order_items but no `carts`
		expect(commerce?.collections).toEqual([
			"orders",
			"products",
			"order_items"
		]);
	});

	it("carries the design-system hue on each frame", () => {
		const frames = framesFor(SAMPLE_POSTGRES);
		const users = frames.find((f) => f.key === "users");
		const commerce = frames.find((f) => f.key === "commerce");
		expect(users?.hue).toBe(210);
		expect(commerce?.hue).toBe(30);
	});

	it("returns [] when any collection lies outside the sample coverage", () => {
		const schema: SchemaModel = {
			engine: "postgres",
			collections: [coll("users"), coll("reviews")], // reviews is unknown
			relations: []
		};
		expect(framesFor(schema)).toEqual([]);
	});

	it("returns [] for an entirely custom schema", () => {
		const schema: SchemaModel = {
			engine: "postgres",
			collections: [coll("alpha"), coll("beta")],
			relations: []
		};
		expect(framesFor(schema)).toEqual([]);
	});

	it("returns [] for an empty schema (no collections → no seeded frames)", () => {
		const schema: SchemaModel = {
			engine: "postgres",
			collections: [],
			relations: []
		};
		// `every` of an empty set is true → passes the coverage guard,
		// mais chaque frame filtre ses collections → toutes vides → filtrées.
		expect(framesFor(schema)).toEqual([]);
	});

	it("drops seed frames whose collections do not intersect the schema", () => {
		const schema: SchemaModel = {
			engine: "postgres",
			collections: [coll("users")],
			relations: []
		};
		const frames = framesFor(schema);
		expect(frames.map((f) => f.key)).toEqual(["users"]);
	});
});
