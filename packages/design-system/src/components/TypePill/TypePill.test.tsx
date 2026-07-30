import { describe, expect, it } from "vitest";
import { renderWithProviders, screen } from "../../test-utils/render";
import { TypePill } from "./TypePill";

describe("TypePill", () => {
	it("displays the type name", () => {
		renderWithProviders(<TypePill type="bigint" />);
		expect(screen.getByText("bigint")).toBeInTheDocument();
	});

	it("appends a ? when nullable is true", () => {
		renderWithProviders(<TypePill type="string" nullable />);
		expect(screen.getByText("string ?")).toBeInTheDocument();
	});
});
