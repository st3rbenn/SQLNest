import { describe, expect, it } from "vitest";
import { colorFor } from "./colors";

describe("colorFor", () => {
	it("is deterministic — same input produces the same output", () => {
		const a = colorFor("users");
		const b = colorFor("users");
		expect(a).toEqual(b);
	});

	it("is stable across many calls", () => {
		const first = colorFor("orders");
		for (let i = 0; i < 10; i += 1) {
			expect(colorFor("orders")).toEqual(first);
		}
	});

	it("returns hues in the [0, 360) range", () => {
		for (const name of ["users", "orders", "products", "xref_p1", "a", ""]) {
			const { hue } = colorFor(name);
			expect(hue).toBeGreaterThanOrEqual(0);
			expect(hue).toBeLessThan(360);
			expect(Number.isInteger(hue)).toBe(true);
		}
	});

	it("returns header/border/text strings referencing the same hue (dark palette)", () => {
		const { hue, header, border, text } = colorFor("commerce");
		// Header : tint SOMBRE + alpha (le shell est #2C2C2C — un pastel clair
		// serait criard). Border : vive, dérivée à L=55 pour rester lisible en
		// pastille comme en contour. Text : nuance claire (compat API).
		expect(header).toBe(`hsla(${hue}, 45%, 22%, 0.85)`);
		expect(border).toBe(`hsl(${hue}, 55%, 55%)`);
		expect(text).toBe(`hsl(${hue}, 45%, 80%)`);
	});

	it("distinct names produce distinct hues (sanity check)", () => {
		// Sur un échantillon varié, on attend au moins 4 teintes distinctes
		// parmi 6 noms — le hash n'est pas parfait mais évite les collisions
		// massives.
		const names = ["users", "orders", "products", "carts", "reviews", "audit"];
		const hues = new Set(names.map((n) => colorFor(n).hue));
		expect(hues.size).toBeGreaterThanOrEqual(4);
	});
});
