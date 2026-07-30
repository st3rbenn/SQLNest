import { describe, expect, it } from "vitest";
import { overviewViewport, tablesBounds } from "./SchemaCanvas";
import type { TableNodeType } from "./TableNode";

function n(id: string, x: number, y: number, w: number, h: number): TableNodeType {
	return {
		id,
		type: "table",
		position: { x, y },
		width: w,
		height: h,
		data: {
			collection: { name: id, fields: [], source: "declared" },
			dimmed: false,
			focused: false,
			matched: false
		}
	};
}

describe("tablesBounds", () => {
	it("returns null on empty", () => {
		expect(tablesBounds([])).toBeNull();
	});

	it("computes the union rectangle", () => {
		const bounds = tablesBounds([
			n("a", 0, 0, 100, 50),
			n("b", 200, 100, 100, 50)
		]);
		expect(bounds).toEqual({ minX: 0, minY: 0, maxX: 300, maxY: 150 });
	});
});

describe("overviewViewport", () => {
	const bounds = { minX: 0, minY: 0, maxX: 1000, maxY: 400 };
	const container = { width: 1440, height: 850 };

	it("caps at maxZoom for small content", () => {
		const vp = overviewViewport(bounds, container, {
			padding: 0.2,
			maxZoom: 0.6
		});
		expect(vp.zoom).toBe(0.6);
	});

	it("centers the content", () => {
		const vp = overviewViewport(bounds, container, {
			padding: 0.2,
			maxZoom: 0.6
		});
		const centerX = (bounds.minX + bounds.maxX) / 2;
		const centerY = (bounds.minY + bounds.maxY) / 2;
		expect(vp.x + centerX * vp.zoom).toBeCloseTo(container.width / 2, 4);
		expect(vp.y + centerY * vp.zoom).toBeCloseTo(container.height / 2, 4);
	});

	it("shrinks below maxZoom when content overflows", () => {
		const large = { minX: 0, minY: 0, maxX: 5000, maxY: 3000 };
		const vp = overviewViewport(large, container, {
			padding: 0.1,
			maxZoom: 1
		});
		expect(vp.zoom).toBeLessThan(1);
		expect(vp.zoom).toBeGreaterThan(0);
	});

	it("respects minZoom", () => {
		const huge = { minX: 0, minY: 0, maxX: 100000, maxY: 60000 };
		const vp = overviewViewport(huge, container, {
			padding: 0.1,
			maxZoom: 1,
			minZoom: 0.05
		});
		expect(vp.zoom).toBe(0.05);
	});
});
