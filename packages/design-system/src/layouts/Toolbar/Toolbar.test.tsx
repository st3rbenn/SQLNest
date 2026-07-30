import { describe, expect, it } from "vitest";
import { renderWithProviders, screen } from "../../test-utils/render";
import { Toolbar } from "./Toolbar";

describe("Toolbar", () => {
	it("renders its children in order", () => {
		renderWithProviders(
			<Toolbar aria-label="canvas">
				<button type="button">A</button>
				<button type="button">B</button>
			</Toolbar>,
		);
		const toolbar = screen.getByRole("toolbar", { name: "canvas" });
		const buttons = toolbar.querySelectorAll("button");
		expect(buttons[0]?.textContent).toBe("A");
		expect(buttons[1]?.textContent).toBe("B");
	});

	it("renders a divider between groups of actions", () => {
		renderWithProviders(
			<Toolbar aria-label="canvas">
				<button type="button">A</button>
				<Toolbar.Divider />
				<button type="button">B</button>
			</Toolbar>,
		);
		expect(screen.getByRole("separator")).toBeInTheDocument();
	});

	it("defaults to vertical orientation", () => {
		renderWithProviders(
			<Toolbar aria-label="canvas">
				<button type="button">A</button>
			</Toolbar>,
		);
		expect(screen.getByRole("toolbar")).toHaveAttribute(
			"aria-orientation",
			"vertical",
		);
	});

	it("exposes aria-orientation horizontal when orientation='horizontal'", () => {
		renderWithProviders(
			<Toolbar orientation="horizontal" aria-label="canvas">
				<button type="button">A</button>
			</Toolbar>,
		);
		expect(screen.getByRole("toolbar")).toHaveAttribute(
			"aria-orientation",
			"horizontal",
		);
	});

	it("renders a horizontal divider when parent is horizontal", () => {
		renderWithProviders(
			<Toolbar orientation="horizontal" aria-label="canvas">
				<button type="button">A</button>
				<Toolbar.Divider orientation="horizontal" />
				<button type="button">B</button>
			</Toolbar>,
		);
		expect(screen.getByRole("separator")).toBeInTheDocument();
	});
});
