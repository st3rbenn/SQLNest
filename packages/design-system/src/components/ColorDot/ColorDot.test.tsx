import { describe, expect, it } from "vitest";
import { renderWithProviders } from "../../test-utils/render";
import { ColorDot } from "./ColorDot";

function getDot(container: HTMLElement): HTMLSpanElement {
	const el = container.querySelector("span");
	if (el === null) throw new Error("ColorDot span not found");
	return el as HTMLSpanElement;
}

describe("ColorDot", () => {
	it("renders a 8px round dot by default (size sm)", () => {
		const { container } = renderWithProviders(<ColorDot color="#ff0000" />);
		const dot = getDot(container);
		expect(dot.style.width).toBe("8px");
		expect(dot.style.height).toBe("8px");
		expect(dot.style.borderRadius).toBe("50%");
	});

	it("applies the color prop as background", () => {
		const { container } = renderWithProviders(<ColorDot color="#123456" />);
		const dot = getDot(container);
		// jsdom normalise "#123456" → "rgb(18, 52, 86)"
		expect(dot.style.background).toMatch(/rgb\(18,\s*52,\s*86\)|#123456/);
	});

	it("renders a 12px squircle when size is lg", () => {
		const { container } = renderWithProviders(
			<ColorDot color="#00ff00" size="lg" />
		);
		const dot = getDot(container);
		expect(dot.style.width).toBe("12px");
		expect(dot.style.height).toBe("12px");
		expect(dot.style.borderRadius).toBe("4px");
	});

	it("forwards aria-label", () => {
		const { container } = renderWithProviders(
			<ColorDot color="#000" aria-label="couleur table users" />
		);
		const dot = getDot(container);
		expect(dot.getAttribute("aria-label")).toBe("couleur table users");
	});
});
