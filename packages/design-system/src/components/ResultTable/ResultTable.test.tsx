import { describe, expect, it } from "vitest";
import { renderWithProviders, screen } from "../../test-utils/render";
import { ResultTable } from "./ResultTable";

describe("ResultTable", () => {
	it("renders column headers and cell values", () => {
		renderWithProviders(
			<ResultTable
				columns={["id", "email"]}
				rows={[{ id: 1, email: "a@b.co" }]}
			/>,
		);
		expect(screen.getByText("id")).toBeInTheDocument();
		expect(screen.getByText("email")).toBeInTheDocument();
		expect(screen.getByText("1")).toBeInTheDocument();
		expect(screen.getByText("a@b.co")).toBeInTheDocument();
	});

	it("renders null/undefined cells as an em dash", () => {
		renderWithProviders(
			<ResultTable columns={["a", "b"]} rows={[{ a: null, b: undefined }]} />,
		);
		const dashes = screen.getAllByText("—");
		expect(dashes.length).toBe(2);
	});

	it("preserves bigint as its string form (no exponential notation)", () => {
		renderWithProviders(
			<ResultTable columns={["big"]} rows={[{ big: 9007199254740993n }]} />,
		);
		expect(screen.getByText("9007199254740993")).toBeInTheDocument();
	});

	it("stringifies object values via JSON.stringify", () => {
		renderWithProviders(
			<ResultTable
				columns={["payload"]}
				rows={[{ payload: { k: "v", n: 2 } }]}
			/>,
		);
		expect(screen.getByText('{"k":"v","n":2}')).toBeInTheDocument();
	});

	it("shows the default empty message when rows is empty", () => {
		renderWithProviders(<ResultTable columns={["a"]} rows={[]} />);
		expect(screen.getByText("Aucune ligne")).toBeInTheDocument();
		// Aucune table rendue quand vide → pas de <thead>.
		expect(screen.queryByRole("columnheader")).toBeNull();
	});

	it("uses a custom empty message when provided", () => {
		renderWithProviders(
			<ResultTable columns={["a"]} rows={[]} emptyMessage="Pas de résultat" />,
		);
		expect(screen.getByText("Pas de résultat")).toBeInTheDocument();
	});

	it("applies maxHeight to the wrapper when provided (number → px)", () => {
		const { container } = renderWithProviders(
			<ResultTable columns={["a"]} rows={[{ a: 1 }]} maxHeight={200} />,
		);
		const wrapper = container.querySelector("table")
			?.parentElement as HTMLElement | null;
		expect(wrapper?.style.maxHeight).toBe("200px");
	});
});
