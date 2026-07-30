import { describe, expect, it } from "vitest";
import { renderWithProviders, screen } from "../../test-utils/render";
import { StatusPill } from "./StatusPill";

describe("StatusPill", () => {
	it("renders its content", () => {
		renderWithProviders(<StatusPill status="success">Live</StatusPill>);
		expect(screen.getByText("Live")).toBeInTheDocument();
	});

	it("uses role=status so assistive tech sees updates", () => {
		renderWithProviders(<StatusPill status="info">Chargement…</StatusPill>);
		expect(screen.getByRole("status")).toHaveTextContent("Chargement…");
	});

	it("shows a colored dot when withDot is true", () => {
		renderWithProviders(
			<StatusPill status="success" withDot>
				Live
			</StatusPill>,
		);
		expect(screen.getByTestId("status-pill-dot")).toBeInTheDocument();
	});

	it("hides the dot by default", () => {
		renderWithProviders(<StatusPill status="danger">Erreur</StatusPill>);
		expect(screen.queryByTestId("status-pill-dot")).toBeNull();
	});
});
