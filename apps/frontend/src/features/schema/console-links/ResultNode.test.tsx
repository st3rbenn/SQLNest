import type { NodeProps } from "@sqlnest/canvas";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConsoleQueryState } from "../../query/consoleQueriesStore";
import { ResultNode, type ResultNodeType } from "./ResultNode";

let state: ConsoleQueryState = { isPending: false, error: null };

vi.mock("../../query/consoleQueriesStore", () => ({
	useConsoleQuery: () => state
}));

const SOURCE = "find track where track_id < 4 pick name";

function mount(source = SOURCE, onClose = () => {}) {
	const props = {
		data: { queryKey: "k", title: "Pistes", source, onClose }
	} as unknown as NodeProps<ResultNodeType>;
	return render(<ResultNode {...props} />);
}

function ran(rows: Record<string, unknown>[]): ConsoleQueryState {
	return {
		isPending: false,
		error: null,
		lastRunAt: 1,
		lastSource: SOURCE,
		data: {
			columns: [
				{ name: "name", type: "string", nullable: false },
				{ name: "composer", type: "string", nullable: true }
			],
			rows,
			rowCount: rows.length,
			written: false
		}
	};
}

describe("ResultNode", () => {
	beforeEach(() => {
		state = { isPending: false, error: null };
	});

	it("n'affiche rien sans résultat", () => {
		const { container } = mount();
		expect(container.innerHTML).toBe("");
	});

	it("montre le titre, le nombre de lignes, les colonnes typées et les valeurs", () => {
		state = ran([{ name: "Balls to the Wall", composer: null }]);
		mount();
		expect(screen.getByText("Pistes")).toBeTruthy();
		expect(screen.getByText("1 ligne")).toBeTruthy();
		expect(screen.getByText("name")).toBeTruthy();
		expect(screen.getByText("string ?")).toBeTruthy();
		expect(screen.getByText("Balls to the Wall")).toBeTruthy();
		expect(screen.getByText("null")).toBeTruthy();
	});

	it("s'arrête à 12 lignes et annonce le reste", () => {
		state = ran(
			Array.from({ length: 20 }, (_, i) => ({
				name: `piste ${i + 1}`,
				composer: "x"
			}))
		);
		mount();
		expect(screen.getByText("20 lignes")).toBeTruthy();
		expect(screen.getByText("piste 12")).toBeTruthy();
		expect(screen.queryByText("piste 13")).toBeNull();
		expect(screen.getByText("+8 lignes…")).toBeTruthy();
	});

	it("signale un résultat périmé quand la requête a changé", () => {
		state = ran([{ name: "a", composer: "b" }]);
		mount(`${SOURCE} sort name`);
		expect(screen.getByText("Périmé")).toBeTruthy();
	});

	it("ne tient pas compte des blancs autour de la requête", () => {
		state = ran([{ name: "a", composer: "b" }]);
		mount(`  ${SOURCE}\n`);
		expect(screen.queryByText("Périmé")).toBeNull();
	});

	it("se ferme par sa croix", () => {
		state = ran([{ name: "a", composer: "b" }]);
		const onClose = vi.fn();
		mount(SOURCE, onClose);
		fireEvent.click(screen.getByRole("button", { name: "Fermer le résultat" }));
		expect(onClose).toHaveBeenCalledOnce();
	});
});
