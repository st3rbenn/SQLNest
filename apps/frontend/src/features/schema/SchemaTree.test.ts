import { describe, expect, it } from "vitest";
import type { Frame } from "./frames";
import { buildTreeGroups } from "./SchemaTree";
import type { SchemaModel } from "./schema-model";

function coll(name: string): SchemaModel["collections"][number] {
	return { name, fields: [], source: "declared" };
}

const frames: Frame[] = [
	{ key: "users", label: "Utilisateurs", hue: 210, collections: ["users"] },
	{
		key: "commerce",
		label: "Commerce",
		hue: 30,
		collections: ["orders", "products", "order_items"]
	}
];

describe("buildTreeGroups", () => {
	it("groups frame-covered tables under their frame first", () => {
		const groups = buildTreeGroups(
			[coll("users"), coll("orders"), coll("products"), coll("order_items")],
			frames
		);
		expect(groups.map((g) => g.label)).toEqual(["Utilisateurs", "Commerce"]);
		expect(groups[0]?.kind).toBe("frame");
		expect(groups[0]?.hue).toBe(210);
		expect(groups[1]?.tables).toEqual(["order_items", "orders", "products"]);
	});

	it("falls back to prefix grouping for tables outside any frame", () => {
		const groups = buildTreeGroups(
			[
				coll("users"),
				coll("xref_p1"),
				coll("xref_p2"),
				coll("xref_p3"),
				coll("logs")
			],
			frames
		);
		const framesFirst = groups.slice(0, 1);
		const rest = groups.slice(1);
		expect(framesFirst[0]?.label).toBe("Utilisateurs");
		const xrefGroup = rest.find((g) => g.label === "xref");
		expect(xrefGroup?.tables).toEqual(["xref_p1", "xref_p2", "xref_p3"]);
	});

	it("frames always come before prefix groups even when smaller", () => {
		const groups = buildTreeGroups(
			[
				coll("users"),
				coll("xref_p1"),
				coll("xref_p2"),
				coll("xref_p3"),
				coll("xref_p4"),
				coll("xref_p5")
			],
			frames
		);
		expect(groups[0]?.kind).toBe("frame");
	});

	it("returns only prefix groups when no frames are provided", () => {
		const groups = buildTreeGroups(
			[coll("users"), coll("orders"), coll("order_items")],
			[]
		);
		expect(groups.every((g) => g.kind === "prefix")).toBe(true);
	});

	it("skips a frame that has no matching collection in the schema", () => {
		const groups = buildTreeGroups([coll("users")], frames);
		expect(groups.find((g) => g.label === "Commerce")).toBeUndefined();
	});
});
