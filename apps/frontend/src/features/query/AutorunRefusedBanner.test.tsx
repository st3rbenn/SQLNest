import { DesignSystemProvider } from "@sqlnest/design-system";
import {
	fireEvent,
	render as rawRender,
	screen
} from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { AutorunRefusedBanner } from "./AutorunRefusedBanner";

function render(node: ReactNode) {
	return rawRender(<DesignSystemProvider>{node}</DesignSystemProvider>);
}

describe("AutorunRefusedBanner [ADR-023 D14]", () => {
	it("rend le message et le shortcut Ctrl+⏎", () => {
		render(<AutorunRefusedBanner onDismiss={vi.fn()} />);
		expect(screen.getByTestId("autorun-refused-banner")).toBeDefined();
		expect(
			screen.getByText(/Autorun refusé/)
		).toBeDefined();
	});

	it("clic × → onDismiss appelé", () => {
		const onDismiss = vi.fn();
		render(<AutorunRefusedBanner onDismiss={onDismiss} />);
		fireEvent.click(screen.getByTestId("autorun-refused-dismiss"));
		expect(onDismiss).toHaveBeenCalledTimes(1);
	});
});
