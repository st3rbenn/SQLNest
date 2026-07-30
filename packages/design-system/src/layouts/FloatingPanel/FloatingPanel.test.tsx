import { describe, expect, it } from "vitest";
import { renderWithProviders, screen } from "../../test-utils/render";
import { FloatingPanel } from "./FloatingPanel";

describe("FloatingPanel", () => {
	it("renders children", () => {
		renderWithProviders(
			<FloatingPanel position="top-left">hello</FloatingPanel>,
		);
		expect(screen.getByText("hello")).toBeInTheDocument();
	});

	it("positions itself absolutely at the requested corner", () => {
		renderWithProviders(
			<FloatingPanel position="bottom-right" data-testid="panel">
				x
			</FloatingPanel>,
		);
		const panel = screen.getByTestId("panel");
		expect(panel).toHaveStyle({ position: "absolute" });
		expect(panel.style.bottom).not.toBe("");
		expect(panel.style.right).not.toBe("");
		expect(panel.style.top).toBe("");
		expect(panel.style.left).toBe("");
	});

	it("centers itself horizontally when position is bottom-center", () => {
		renderWithProviders(
			<FloatingPanel position="bottom-center" data-testid="panel">
				x
			</FloatingPanel>,
		);
		const panel = screen.getByTestId("panel");
		expect(panel.style.left).toBe("50%");
		expect(panel.style.transform).toContain("translateX(-50%)");
	});

	it("applies a custom numeric offset", () => {
		renderWithProviders(
			<FloatingPanel position="top-left" offset={24} data-testid="panel">
				x
			</FloatingPanel>,
		);
		const panel = screen.getByTestId("panel");
		expect(panel.style.top).toBe("24px");
		expect(panel.style.left).toBe("24px");
	});

	it("applies asymmetric offsets from an object", () => {
		renderWithProviders(
			<FloatingPanel
				position="bottom-left"
				offset={{ x: 82, y: 24 }}
				data-testid="panel"
			>
				x
			</FloatingPanel>,
		);
		const panel = screen.getByTestId("panel");
		expect(panel.style.left).toBe("82px");
		expect(panel.style.bottom).toBe("24px");
	});
});
