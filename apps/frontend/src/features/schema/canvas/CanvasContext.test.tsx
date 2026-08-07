import { render, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
	type CanvasActionsContextValue,
	type CanvasDataContextValue,
	type CanvasFocusContextValue,
	CanvasProviders,
	type CanvasUIContextValue,
	useCanvasActionsCtx,
	useCanvasData,
	useCanvasFocusCtx,
	useCanvasUI
} from "./CanvasContext";

// Minimal fixtures — on ne teste PAS les hooks canvas, juste le fait que
// les 4 contexts sont bien fournis + guardés en cas d'usage hors provider.
const noop = () => {};
const fakeData: CanvasDataContextValue = {
	schema: {
		engine: "postgres",
		collections: [],
		relations: []
	} as unknown as CanvasDataContextValue["schema"],
	schemaLabel: undefined,
	framesApi: {} as CanvasDataContextValue["framesApi"],
	hiddenIds: new Set()
};
const fakeFocus: CanvasFocusContextValue = {
	focusId: null,
	focusFrameKey: null,
	focusedFrame: undefined,
	setFocusId: noop,
	setFocusFrameKey: noop,
	focusNode: noop,
	focusFrame: noop,
	clearFocus: noop,
	focusAndZoom: noop,
	applyOverview: noop
};
const fakeUI: CanvasUIContextValue = {
	search: "",
	setSearch: noop,
	menu: null,
	setMenu: noop,
	activeTool: "select",
	setActiveTool: noop,
	leftDrawerVisible: true,
	setLeftDrawerVisible: noop,
	leftDrawerWidth: 320,
	drawerHandleProps: {
		onPointerDown: noop,
		onPointerMove: noop,
		onPointerUp: noop,
		onPointerCancel: noop
	},
	leftPadding: 328,
	consoleHeight: 38,
	setConsoleHeight: noop,
	consoleGap: 8,
	layoutConfirmOpen: false,
	setLayoutConfirmOpen: noop,
	selectedTables: [],
	clearSelection: noop
};
const fakeActions: CanvasActionsContextValue = {
	hideTable: noop,
	unhideAll: noop,
	hideSelected: noop,
	createFrameFromSelection: noop,
	handleFrameRename: noop,
	handleFrameDelete: noop,
	relayoutAll: noop,
	addTableToFrame: noop,
	removeTableFromFrame: noop,
	commandGroups: []
};

function wrap(children: React.ReactNode) {
	return (
		<CanvasProviders
			data={fakeData}
			focus={fakeFocus}
			ui={fakeUI}
			actions={fakeActions}
		>
			{children}
		</CanvasProviders>
	);
}

describe("CanvasContext", () => {
	it("fournit les 4 contextes aux consumers", () => {
		const { result } = renderHook(
			() => ({
				data: useCanvasData(),
				focus: useCanvasFocusCtx(),
				ui: useCanvasUI(),
				actions: useCanvasActionsCtx()
			}),
			{
				wrapper: ({ children }) => (
					<CanvasProviders
						data={fakeData}
						focus={fakeFocus}
						ui={fakeUI}
						actions={fakeActions}
					>
						{children}
					</CanvasProviders>
				)
			}
		);
		expect(result.current.data.schema.engine).toBe("postgres");
		expect(result.current.focus.focusId).toBe(null);
		expect(result.current.ui.activeTool).toBe("select");
		expect(result.current.actions.commandGroups).toEqual([]);
	});

	it("useCanvasData hors provider lève une erreur descriptive", () => {
		// Silence React's error boundary noise
		const spy = vi.spyOn(console, "error").mockImplementation(noop);
		expect(() => renderHook(() => useCanvasData())).toThrow(
			/useCanvasData\(\) called outside <CanvasProviders>/
		);
		spy.mockRestore();
	});

	it("useCanvasFocusCtx hors provider lève une erreur descriptive", () => {
		const spy = vi.spyOn(console, "error").mockImplementation(noop);
		expect(() => renderHook(() => useCanvasFocusCtx())).toThrow(
			/useCanvasFocusCtx\(\) called outside <CanvasProviders>/
		);
		spy.mockRestore();
	});

	it("useCanvasUI hors provider lève une erreur descriptive", () => {
		const spy = vi.spyOn(console, "error").mockImplementation(noop);
		expect(() => renderHook(() => useCanvasUI())).toThrow(
			/useCanvasUI\(\) called outside <CanvasProviders>/
		);
		spy.mockRestore();
	});

	it("useCanvasActionsCtx hors provider lève une erreur descriptive", () => {
		const spy = vi.spyOn(console, "error").mockImplementation(noop);
		expect(() => renderHook(() => useCanvasActionsCtx())).toThrow(
			/useCanvasActionsCtx\(\) called outside <CanvasProviders>/
		);
		spy.mockRestore();
	});

	it("un composant enfant peut lire plusieurs slots dans le même render", () => {
		function TestConsumer() {
			const { schema } = useCanvasData();
			const { activeTool } = useCanvasUI();
			return (
				<div data-testid="probe">
					{schema.engine}:{activeTool}
				</div>
			);
		}
		const { getByTestId } = render(wrap(<TestConsumer />));
		expect(getByTestId("probe").textContent).toBe("postgres:select");
	});
});
