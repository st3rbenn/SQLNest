import { describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen, userEvent } from "../../test-utils/render";
import { SelectionChip } from "./SelectionChip";

describe("SelectionChip", () => {
	it("shows the current selection count", () => {
		renderWithProviders(
			<SelectionChip
				count={3}
				actions={[]}
				onClear={() => {}}
				label="tables"
			/>,
		);
		expect(screen.getByText(/3 tables sélectionnées/i)).toBeInTheDocument();
	});

	it("uses singular label for a single selection", () => {
		renderWithProviders(
			<SelectionChip
				count={1}
				actions={[]}
				onClear={() => {}}
				label="table"
			/>,
		);
		expect(screen.getByText(/1 table sélectionnée/i)).toBeInTheDocument();
	});

	it("renders each action as a clickable button", async () => {
		const onFrame = vi.fn();
		renderWithProviders(
			<SelectionChip
				count={3}
				actions={[{ id: "frame", label: "Frame", hint: "F", onClick: onFrame }]}
				onClear={() => {}}
				label="tables"
			/>,
		);
		await userEvent.click(screen.getByRole("button", { name: /frame/i }));
		expect(onFrame).toHaveBeenCalledOnce();
	});

	it("calls onClear when the close button is clicked", async () => {
		const onClear = vi.fn();
		renderWithProviders(
			<SelectionChip
				count={3}
				actions={[]}
				onClear={onClear}
				label="tables"
			/>,
		);
		await userEvent.click(screen.getByRole("button", { name: /fermer/i }));
		expect(onClear).toHaveBeenCalledOnce();
	});
});
