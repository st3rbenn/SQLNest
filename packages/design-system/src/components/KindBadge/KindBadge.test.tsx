import { describe, expect, it } from "vitest";
import { renderWithProviders, screen } from "../../test-utils/render";
import { KindBadge } from "./KindBadge";

describe("KindBadge", () => {
	it("shows DÉCLARÉ for the declared kind", () => {
		renderWithProviders(<KindBadge kind="declared" />);
		expect(screen.getByText(/déclaré/i)).toBeInTheDocument();
	});

	it("shows INFÉRÉ for the inferred kind", () => {
		renderWithProviders(<KindBadge kind="inferred" />);
		expect(screen.getByText(/inféré/i)).toBeInTheDocument();
	});

	it("shows PK for the primary-key kind", () => {
		renderWithProviders(<KindBadge kind="pk" />);
		expect(screen.getByText("PK")).toBeInTheDocument();
	});

	it("accepts a shorter label override for tight layouts", () => {
		renderWithProviders(<KindBadge kind="declared" label="DÉCL." />);
		expect(screen.getByText("DÉCL.")).toBeInTheDocument();
	});
});
