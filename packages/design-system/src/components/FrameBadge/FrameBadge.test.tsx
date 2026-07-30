import { describe, expect, it } from "vitest";
import { renderWithProviders, screen } from "../../test-utils/render";
import { FrameBadge } from "./FrameBadge";

describe("FrameBadge", () => {
	it("renders the label", () => {
		renderWithProviders(<FrameBadge hue={210} label="Utilisateurs" />);
		expect(screen.getByText(/utilisateurs/i)).toBeInTheDocument();
	});

	it("renders the count next to the label when provided", () => {
		renderWithProviders(<FrameBadge hue={30} label="Commerce" count={5} />);
		expect(screen.getByText("Commerce · 5")).toBeInTheDocument();
	});

	it("applies the given hue to its background", () => {
		renderWithProviders(
			<FrameBadge hue={340} label="Cross-refs" data-testid="frame" />,
		);
		const badge = screen.getByTestId("frame");
		expect(badge.style.background).toContain("340");
	});
});
