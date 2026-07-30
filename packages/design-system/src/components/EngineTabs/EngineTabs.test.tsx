import { describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen, userEvent } from "../../test-utils/render";
import { EngineTabs } from "./EngineTabs";

describe("EngineTabs", () => {
	it("renders the two default engines", () => {
		renderWithProviders(<EngineTabs value="postgres" onChange={() => {}} />);
		expect(
			screen.getByRole("radio", { name: /postgresql/i }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("radio", { name: /mongodb/i }),
		).toBeInTheDocument();
	});

	it("marks the selected engine as checked", () => {
		renderWithProviders(<EngineTabs value="mongodb" onChange={() => {}} />);
		expect(screen.getByRole("radio", { name: /mongodb/i })).toBeChecked();
		expect(
			screen.getByRole("radio", { name: /postgresql/i }),
		).not.toBeChecked();
	});

	it("calls onChange when the other engine is picked", async () => {
		const onChange = vi.fn();
		renderWithProviders(<EngineTabs value="postgres" onChange={onChange} />);
		await userEvent.click(screen.getByRole("radio", { name: /mongodb/i }));
		expect(onChange).toHaveBeenCalledWith("mongodb");
	});
});
