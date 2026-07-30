import { describe, expect, it } from "vitest";
import { renderWithProviders, screen } from "../../test-utils/render";
import { HintPill } from "./HintPill";

describe("HintPill", () => {
	it("renders the text and the keys", () => {
		renderWithProviders(<HintPill keys={["⌘", "K"]}>Actions rapides</HintPill>);
		expect(screen.getByText("Actions rapides")).toBeInTheDocument();
		expect(screen.getByText("⌘")).toBeInTheDocument();
		expect(screen.getByText("K")).toBeInTheDocument();
	});

	it("renders each key as a <kbd> element", () => {
		renderWithProviders(<HintPill keys={["⌘K"]}>Palette</HintPill>);
		const kbd = screen.getByText("⌘K");
		expect(kbd.tagName.toLowerCase()).toBe("kbd");
	});
});
