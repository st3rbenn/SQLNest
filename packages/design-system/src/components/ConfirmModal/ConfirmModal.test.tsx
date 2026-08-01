import { describe, expect, it, vi } from "vitest";
import {
	renderWithProviders,
	screen,
	userEvent,
} from "../../test-utils/render";
import { ConfirmModal } from "./ConfirmModal";

describe("ConfirmModal", () => {
	it("renders title, message and default labels when opened", () => {
		renderWithProviders(
			<ConfirmModal
				opened
				onClose={() => {}}
				onConfirm={() => {}}
				title="Titre"
				message="Message important"
			/>,
		);
		expect(screen.getByText("Titre")).toBeInTheDocument();
		expect(screen.getByText("Message important")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Annuler" })).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Confirmer" }),
		).toBeInTheDocument();
	});

	it("uses custom labels when provided", () => {
		renderWithProviders(
			<ConfirmModal
				opened
				onClose={() => {}}
				onConfirm={() => {}}
				title="X"
				message="Y"
				confirmLabel="Réappliquer"
				cancelLabel="Retour"
			/>,
		);
		expect(
			screen.getByRole("button", { name: "Réappliquer" }),
		).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Retour" })).toBeInTheDocument();
	});

	it("calls onClose (only) when cancel is clicked", async () => {
		const onClose = vi.fn();
		const onConfirm = vi.fn();
		renderWithProviders(
			<ConfirmModal
				opened
				onClose={onClose}
				onConfirm={onConfirm}
				title="X"
				message="Y"
			/>,
		);
		await userEvent.click(screen.getByRole("button", { name: "Annuler" }));
		expect(onClose).toHaveBeenCalledTimes(1);
		expect(onConfirm).not.toHaveBeenCalled();
	});

	it("closes before invoking onConfirm when confirm is clicked", async () => {
		const calls: string[] = [];
		const onClose = vi.fn(() => calls.push("close"));
		const onConfirm = vi.fn(() => calls.push("confirm"));
		renderWithProviders(
			<ConfirmModal
				opened
				onClose={onClose}
				onConfirm={onConfirm}
				title="X"
				message="Y"
			/>,
		);
		await userEvent.click(screen.getByRole("button", { name: "Confirmer" }));
		expect(onClose).toHaveBeenCalledTimes(1);
		expect(onConfirm).toHaveBeenCalledTimes(1);
		expect(calls).toEqual(["close", "confirm"]);
	});

	it("renders nothing visible when not opened", () => {
		renderWithProviders(
			<ConfirmModal
				opened={false}
				onClose={() => {}}
				onConfirm={() => {}}
				title="Titre caché"
				message="Message caché"
			/>,
		);
		expect(screen.queryByText("Titre caché")).not.toBeInTheDocument();
		expect(screen.queryByText("Message caché")).not.toBeInTheDocument();
	});
});
