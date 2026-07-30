import { describe, expect, it } from "vitest";
import { renderWithProviders, screen } from "../../test-utils/render";
import { VerticalToolbar } from "./VerticalToolbar";

describe("VerticalToolbar", () => {
	it("renders its children in order", () => {
		renderWithProviders(
			<VerticalToolbar aria-label="canvas">
				<button type="button">A</button>
				<button type="button">B</button>
			</VerticalToolbar>,
		);
		const toolbar = screen.getByRole("toolbar", { name: "canvas" });
		const buttons = toolbar.querySelectorAll("button");
		expect(buttons[0]?.textContent).toBe("A");
		expect(buttons[1]?.textContent).toBe("B");
	});

	it("renders a vertical divider between groups of actions", () => {
		renderWithProviders(
			<VerticalToolbar aria-label="canvas">
				<button type="button">A</button>
				<VerticalToolbar.Divider />
				<button type="button">B</button>
			</VerticalToolbar>,
		);
		expect(screen.getByRole("separator")).toBeInTheDocument();
	});

	it("exposes an aria-orientation of vertical", () => {
		renderWithProviders(
			<VerticalToolbar aria-label="canvas">
				<button type="button">A</button>
			</VerticalToolbar>,
		);
		expect(screen.getByRole("toolbar")).toHaveAttribute(
			"aria-orientation",
			"vertical",
		);
	});
});
