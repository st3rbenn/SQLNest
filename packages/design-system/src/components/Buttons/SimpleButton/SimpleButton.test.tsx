import { describe, expect, it, vi } from "vitest";
import {
	renderWithProviders,
	screen,
	userEvent,
} from "../../../test-utils/render";
import { SimpleButton } from "./SimpleButton";

describe("SimpleButton", () => {
	it("renders its label and forwards clicks", async () => {
		const onClick = vi.fn();
		renderWithProviders(
			<SimpleButton onClick={onClick}>Exécuter</SimpleButton>,
		);
		await userEvent.click(screen.getByRole("button", { name: /exécuter/i }));
		expect(onClick).toHaveBeenCalledOnce();
	});

	describe("loading", () => {
		it("disables the button and blocks clicks", async () => {
			const onClick = vi.fn();
			renderWithProviders(
				<SimpleButton loading onClick={onClick}>
					Exécuter
				</SimpleButton>,
			);
			const button = screen.getByRole("button", { name: /exécuter/i });
			expect(button).toBeDisabled();
			await userEvent.click(button);
			expect(onClick).not.toHaveBeenCalled();
		});

		it("keeps the children label when no loadingLabel is provided", () => {
			renderWithProviders(<SimpleButton loading>Exécuter</SimpleButton>);
			expect(
				screen.getByRole("button", { name: /exécuter/i }),
			).toBeInTheDocument();
		});

		it("swaps to loadingLabel when provided", () => {
			renderWithProviders(
				<SimpleButton loading loadingLabel="Exécution…">
					Exécuter
				</SimpleButton>,
			);
			expect(
				screen.getByRole("button", { name: /exécution/i }),
			).toBeInTheDocument();
			expect(screen.queryByText("Exécuter")).not.toBeInTheDocument();
		});

		it("applies the lighter loading style with default cursor", () => {
			renderWithProviders(<SimpleButton loading>Exécuter</SimpleButton>);
			const button = screen.getByRole("button", { name: /exécuter/i });
			expect(button).toHaveAttribute("data-loading", "true");
			expect(button.style.cursor).toBe("default");
			expect(button.style.background).toContain("blue-3");
		});
	});
});
