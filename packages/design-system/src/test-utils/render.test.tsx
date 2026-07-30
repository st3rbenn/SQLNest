import { describe, expect, it } from "vitest";
import { renderWithProviders, screen } from "./render";

describe("renderWithProviders", () => {
	it("renders the tree wrapped in DesignSystemProvider", () => {
		renderWithProviders(<span>hello</span>);
		expect(screen.getByText("hello")).toBeInTheDocument();
	});
});
