import { describe, expect, it, vi } from "vitest";
import {
	renderWithProviders,
	screen,
	userEvent
} from "../../test-utils/render";
import { RowItem } from "./RowItem";

describe("RowItem", () => {
	it("renders the label", () => {
		renderWithProviders(<RowItem label="orders" />);
		expect(screen.getByText("orders")).toBeInTheDocument();
	});

	it("fires onClick when activated", async () => {
		const onClick = vi.fn();
		renderWithProviders(<RowItem label="users" onClick={onClick} />);
		await userEvent.click(screen.getByRole("button"));
		expect(onClick).toHaveBeenCalledOnce();
	});

	it("applies the active style (accent bg + left border + weight 600)", () => {
		renderWithProviders(<RowItem label="orders" active />);
		const btn = screen.getByRole("button");
		expect(btn.style.background).toContain("sqlnest-accent-soft");
		expect(btn.style.borderLeft).toContain("sqlnest-accent");
		expect(btn.style.fontWeight).toBe("600");
	});

	it("renders a ColorDot when color is set, and omits it otherwise", () => {
		const { container: withColor } = renderWithProviders(
			<RowItem label="orders" color="#123456" />
		);
		// ColorDot renders a <span> (styled dot) before the label.
		const dots = withColor.querySelectorAll("button > span");
		// dot + label span → 2 direct <span> children of the button
		expect(dots.length).toBeGreaterThanOrEqual(2);

		const { container: noColor } = renderWithProviders(
			<RowItem label="orders" />
		);
		// only label span → 1 direct <span> child
		expect(noColor.querySelectorAll("button > span").length).toBe(1);
	});

	it("always renders a chevron (svg)", () => {
		const { container } = renderWithProviders(<RowItem label="orders" />);
		expect(container.querySelector("button > svg")).not.toBeNull();
	});
});
