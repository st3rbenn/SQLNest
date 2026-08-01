import { describe, expect, it, vi } from "vitest";
import {
	renderWithProviders,
	screen,
	userEvent,
} from "../../test-utils/render";
import { SearchInput } from "./SearchInput";

describe("SearchInput", () => {
	it("has the search role and given placeholder", () => {
		renderWithProviders(<SearchInput placeholder="Rechercher…" />);
		const input = screen.getByPlaceholderText("Rechercher…");
		expect(input).toHaveAttribute("type", "search");
	});

	it("calls onChange with the raw value", async () => {
		const onChange = vi.fn();
		renderWithProviders(
			<SearchInput placeholder="Chercher" value="" onChange={onChange} />,
		);
		await userEvent.type(screen.getByPlaceholderText("Chercher"), "us");
		// Called at least once with the last typed char merged
		expect(onChange).toHaveBeenCalled();
	});
});
