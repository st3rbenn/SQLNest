import { describe, expect, it } from "vitest";
import { renderWithProviders, screen } from "../../test-utils/render";
import { AppShell } from "./AppShell";

describe("AppShell", () => {
	it("renders the header slot and the main body", () => {
		renderWithProviders(
			<AppShell header={<span>topbar</span>}>
				<main>body</main>
			</AppShell>,
		);
		expect(screen.getByText("topbar")).toBeInTheDocument();
		expect(screen.getByText("body")).toBeInTheDocument();
	});

	it("renders the header at role='banner'", () => {
		renderWithProviders(
			<AppShell header={<span>topbar</span>}>
				<main>body</main>
			</AppShell>,
		);
		expect(screen.getByRole("banner")).toHaveTextContent("topbar");
	});
});
