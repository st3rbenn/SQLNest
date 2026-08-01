import { describe, expect, it } from "vitest";
import { levelForZoom, ZOOM_LEVELS } from "./zoomLevel";

describe("levelForZoom", () => {
	it("returns 'full' at zoom ≥ FULL_MIN", () => {
		expect(levelForZoom(1)).toBe("full");
		expect(levelForZoom(ZOOM_LEVELS.FULL_MIN)).toBe("full");
		expect(levelForZoom(2)).toBe("full");
	});

	it("returns 'compact' between COMPACT_MIN and FULL_MIN", () => {
		expect(levelForZoom(0.299)).toBe("compact");
		expect(levelForZoom(ZOOM_LEVELS.COMPACT_MIN)).toBe("compact");
		expect(levelForZoom(0.25)).toBe("compact");
	});

	it("returns 'pill' between PILL_MIN and COMPACT_MIN", () => {
		expect(levelForZoom(0.199)).toBe("pill");
		expect(levelForZoom(ZOOM_LEVELS.PILL_MIN)).toBe("pill");
		expect(levelForZoom(0.15)).toBe("pill");
	});

	it("returns 'dot' below PILL_MIN", () => {
		expect(levelForZoom(0.099)).toBe("dot");
		expect(levelForZoom(0.05)).toBe("dot");
		expect(levelForZoom(0.02)).toBe("dot");
	});

	it("is stable at exact thresholds (upper level wins)", () => {
		expect(levelForZoom(ZOOM_LEVELS.FULL_MIN)).toBe("full");
		expect(levelForZoom(ZOOM_LEVELS.COMPACT_MIN)).toBe("compact");
		expect(levelForZoom(ZOOM_LEVELS.PILL_MIN)).toBe("pill");
	});
});
