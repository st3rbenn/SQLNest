import { act, renderHook } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { Frame } from "../frames";
import type { FramesApi } from "../useFrames";
import type { PositionsApi, PositionsMap, XY } from "../useTablePositions";
import type { SizesApi, SizesMap, TableSize } from "../useTableSizes";
import {
	type CanvasSnapshot,
	useCanvasHistory,
	type UseCanvasHistoryOptions
} from "./useCanvasHistory";

/**
 * Harness minimal — chaque source (positions/sizes/frames/hiddenIds) est
 * stockée via un `useState` local ; on expose l'API attendue par
 * `useCanvasHistory` (positions/setPosition/... + replaceAll) et on retourne
 * aussi les mutators du harness pour simuler les gestes user depuis les
 * tests.
 *
 * Convention : les mutations + push d'un même « geste user » sont regroupées
 * dans UN act() — miroir de la réalité où le handler DOM (drag-stop, resize
 * end, F pour créer un frame, etc.) mute puis push synchrone dans la même
 * task React.
 */
function useHarness(onRestore?: (s: CanvasSnapshot) => void) {
	const [positions, setPositions] = useState<PositionsMap>({});
	const [sizes, setSizes] = useState<SizesMap>({});
	const [frames, setFrames] = useState<readonly Frame[]>([]);
	const [hiddenIds, setHiddenIds] = useState<ReadonlySet<string>>(new Set());

	const tablePositions: PositionsApi = {
		positions,
		setPosition: (name: string, xy: XY) =>
			setPositions((prev) => ({ ...prev, [name]: xy })),
		setManyPositions: (entries) =>
			setPositions((prev) => ({ ...prev, ...entries })),
		replaceAll: (next: PositionsMap) => setPositions(next)
	};
	const tableSizes: SizesApi = {
		sizes,
		setSize: (name: string, size: TableSize) =>
			setSizes((prev) => ({ ...prev, [name]: size })),
		replaceAll: (next: SizesMap) => setSizes(next)
	};
	const framesApi: FramesApi = {
		frames,
		frameOfTable: () => null,
		createFrame: () => ({
			key: "x",
			label: "x",
			hue: 0,
			collections: []
		}),
		removeFrame: () => {},
		renameFrame: () => {},
		removeTableFromFrame: () => {},
		addTableToFrame: () => {},
		moveFrame: () => {},
		setFrameRect: () => {},
		replaceAll: (next: readonly Frame[]) => setFrames(next)
	};

	const opts: UseCanvasHistoryOptions = {
		tablePositions,
		tableSizes,
		framesApi,
		hiddenIds,
		setHiddenIds,
		...(onRestore ? { onRestore } : {})
	};
	const history = useCanvasHistory(opts);
	return {
		history,
		snapshot: { positions, sizes, frames, hiddenIds },
		mutate: { setPositions, setSizes, setFrames, setHiddenIds }
	};
}

describe("useCanvasHistory", () => {
	it("undo restore les 4 sources via replaceAll (positions/sizes/frames/hiddenIds)", () => {
		const { result } = renderHook(() => useHarness());

		// Geste 1 (drag d'une table) : mute puis push, même act.
		act(() => {
			result.current.mutate.setPositions({ users: { x: 100, y: 200 } });
			result.current.history.push();
		});

		// Geste 2 (create frame + drag une autre table + hide + resize) :
		// mute les 4 sources puis push, même act.
		act(() => {
			result.current.mutate.setPositions({
				users: { x: 100, y: 200 },
				orders: { x: 300, y: 400 }
			});
			result.current.mutate.setSizes({ users: { width: 250 } });
			result.current.mutate.setFrames([
				{ key: "f1", label: "F1", hue: 210, collections: ["users"] }
			]);
			result.current.mutate.setHiddenIds(new Set(["products"]));
			result.current.history.push();
		});

		expect(result.current.history.canUndo).toBe(true);

		// Undo — revient à l'état PRÉ-geste-2 : seules les positions issues
		// du geste 1 sont là, les 3 autres sources sont vides.
		act(() => {
			result.current.history.undo();
		});

		expect(result.current.snapshot.positions).toEqual({
			users: { x: 100, y: 200 }
		});
		expect(result.current.snapshot.sizes).toEqual({});
		expect(result.current.snapshot.frames).toEqual([]);
		expect(result.current.snapshot.hiddenIds).toEqual(new Set());
		expect(result.current.history.canRedo).toBe(true);
	});

	it("onRestore est invoqué avec le snapshot restauré à chaque undo/redo", () => {
		// Bug 1 : sans ce callback, React Flow `nodes` (détenu ailleurs, hors
		// API du hook) n'est jamais resync après un restore → Cmd+Z ne bouge
		// visuellement rien. Le hook expose donc un `onRestore` pour laisser
		// le consommateur (SchemaCanvas) réappliquer les overlays du snapshot
		// sur ses `nodes` RF.
		const onRestore = vi.fn<(s: CanvasSnapshot) => void>();
		const { result } = renderHook(() => useHarness(onRestore));

		// Geste : mute + push, même act (voir docblock du harness).
		act(() => {
			result.current.mutate.setPositions({ a: { x: 1, y: 2 } });
			result.current.history.push();
		});

		expect(onRestore).not.toHaveBeenCalled();

		act(() => {
			result.current.history.undo();
		});
		expect(onRestore).toHaveBeenCalledTimes(1);
		expect(onRestore).toHaveBeenLastCalledWith(
			expect.objectContaining({ positions: {} })
		);

		act(() => {
			result.current.history.redo();
		});
		expect(onRestore).toHaveBeenCalledTimes(2);
		expect(onRestore).toHaveBeenLastCalledWith(
			expect.objectContaining({ positions: { a: { x: 1, y: 2 } } })
		);
	});
});
