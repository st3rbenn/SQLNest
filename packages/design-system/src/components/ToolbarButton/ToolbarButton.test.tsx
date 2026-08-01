import { describe, expect, it, vi } from "vitest";
import {
	renderWithProviders,
	screen,
	userEvent,
} from "../../test-utils/render";
import { ToolbarButton } from "./ToolbarButton";

const Icon = () => (
	<svg width={16} height={16}>
		<title>x</title>
	</svg>
);

describe("ToolbarButton", () => {
	it("uses the label as accessible name and tooltip", async () => {
		renderWithProviders(
			<ToolbarButton label="Sélection (V)">
				<Icon />
			</ToolbarButton>,
		);
		expect(
			screen.getByRole("button", { name: "Sélection (V)" }),
		).toBeInTheDocument();
	});

	it("fires onClick when activated", async () => {
		const onClick = vi.fn();
		renderWithProviders(
			<ToolbarButton label="Frame" onClick={onClick}>
				<Icon />
			</ToolbarButton>,
		);
		await userEvent.click(screen.getByRole("button"));
		expect(onClick).toHaveBeenCalledOnce();
	});

	it("marks itself pressed when active is true", () => {
		renderWithProviders(
			<ToolbarButton label="Sélection" active>
				<Icon />
			</ToolbarButton>,
		);
		expect(screen.getByRole("button")).toHaveAttribute("aria-pressed", "true");
	});

	it("shows a status dot when statusDot is set", () => {
		renderWithProviders(
			<ToolbarButton label="Diff" statusDot="warning">
				<Icon />
			</ToolbarButton>,
		);
		expect(screen.getByTestId("toolbar-button-status")).toBeInTheDocument();
	});
});
