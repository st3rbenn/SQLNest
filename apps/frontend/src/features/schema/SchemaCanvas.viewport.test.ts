import { describe, expect, it } from "vitest";
import { focusZoom, overviewViewport, tablesBounds } from "./SchemaCanvas";
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

	it("centers into the free area when safeArea is provided", () => {
		const vp = overviewViewport(bounds, container, {
			padding: 0,
			maxZoom: 1,
			safeArea: { left: 400, right: 0, top: 0, bottom: 0 }
		});
		// Free area starts at x=400, spans 1040 → center x = 920.
		// content center = 500, at zoom vp.zoom → vp.x + 500*zoom == 920
		expect(vp.x + 500 * vp.zoom).toBeCloseTo(920, 4);
	});
});

describe("focusZoom", () => {
	const opts = { min: 1, max: 1.5 };

	it("zooms IN to min when the current zoom is below min", () => {
		expect(focusZoom(0.4, opts)).toBe(1);
	});

	it("zooms OUT to max when the current zoom is above max", () => {
		expect(focusZoom(2.5, opts)).toBe(1.5);
	});

	it("KEEPS the current zoom when it is inside the focus window (just pan)", () => {
		expect(focusZoom(1, opts)).toBe(1);
		expect(focusZoom(1.2, opts)).toBe(1.2);
		expect(focusZoom(1.5, opts)).toBe(1.5);
	});
});
