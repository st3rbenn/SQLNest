import { describe, expect, it } from "vitest";
import { jsonDepthExceeds } from "./json-depth";

describe("jsonDepthExceeds", () => {
	it("returns false for primitives", () => {
		expect(jsonDepthExceeds(null)).toBe(false);
		expect(jsonDepthExceeds(42)).toBe(false);
		expect(jsonDepthExceeds("hello")).toBe(false);
		expect(jsonDepthExceeds(true)).toBe(false);
	});

	it("returns false for flat object within limit", () => {
		expect(jsonDepthExceeds({ a: 1, b: 2 }, 2)).toBe(false);
	});

	it("returns false for nested object within limit", () => {
		expect(jsonDepthExceeds({ a: { b: { c: 1 } } }, 3)).toBe(false);
	});

	it("returns true for object exceeding limit", () => {
		expect(jsonDepthExceeds({ a: { b: { c: { d: 1 } } } }, 2)).toBe(true);
	});

	it("checks arrays", () => {
		expect(jsonDepthExceeds([1, 2, 3], 2)).toBe(false);
		expect(jsonDepthExceeds([[[[1]]]], 2)).toBe(true);
	});

	it("handles mixed arrays and objects", () => {
		const deep = { a: [{ b: [{ c: 1 }] }] };
		expect(jsonDepthExceeds(deep, 5)).toBe(false);
		expect(jsonDepthExceeds(deep, 3)).toBe(true);
	});

	it("uses default limit of 10", () => {
		let value: unknown = 1;
		for (let i = 0; i < 10; i++) {
			value = { x: value };
		}
		expect(jsonDepthExceeds(value)).toBe(false);

		value = { deeper: value };
		expect(jsonDepthExceeds(value)).toBe(true);
	});
});
