import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode, useRef, useState } from "react";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	type Mock,
	vi
} from "vitest";
import type { Frame } from "../frames";
import type { LayoutResult } from "../layout";
import type { TableNodeType } from "../TableNode";
import type { AnchorMap, AnchorsApi } from "../useEdgeAnchors";
import type { FramesApi } from "../useFrames";
import type { PositionsApi, PositionsMap } from "../useTablePositions";
import type { SizesApi, SizesMap } from "../useTableSizes";
import { useCanvasHistory } from "./useCanvasHistory";
import { useCanvasSyncBridge } from "./useCanvasSyncBridge";

vi.mock("../../auth/sessionQuery", () => ({
	useCurrentUser: vi.fn(() => ({
		data: { user: { id: "u1", email: "u@x", name: "u" } }
	}))
}));
vi.mock("../../teams/useCurrentTeam", () => ({
	useCurrentTeamSlug: vi.fn(() => "test-team")
}));

window.CONTEXT = { apiBaseUrl: "http://api.test" };

function makeWrapper() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } }
	});
	return function Wrapper({ children }: { readonly children: ReactNode }) {
		return createElement(
			QueryClientProvider,
			{ client } as never,
			children as never
		);
	};
}

function mockResponse(status: number, body: unknown): Response {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => body
	} as unknown as Response;
}

/**
 * Câblage SchemaCanvas réduit : sources canvas en `useState` vides au
 * mount (comme un user loggé, `persistLocal=false`), historique déclaré
 * AVANT le bridge, `onHydrated` branché sur `history.resetBaseline`.
 */
function useWiring() {
	const [positions, setPositions] = useState<PositionsMap>({});
	const [sizes, setSizes] = useState<SizesMap>({});
	const [frames, setFrames] = useState<readonly Frame[]>([]);
	const [hiddenIds, setHiddenIds] = useState<ReadonlySet<string>>(
		() => new Set()
	);
	const [overrides, setOverrides] = useState<AnchorMap>({} as AnchorMap);
	const [, setNodes] = useState<TableNodeType[]>([]);
	const baseRef = useRef<LayoutResult | null>(null);

	const tablePositions: PositionsApi = {
		positions,
		setPosition: (name, xy) => setPositions((p) => ({ ...p, [name]: xy })),
		setManyPositions: (entries) => setPositions((p) => ({ ...p, ...entries })),
		replaceAll: setPositions
	};
	const tableSizes: SizesApi = {
		sizes,
		setSize: (name, size) => setSizes((p) => ({ ...p, [name]: size })),
		replaceAll: setSizes
	};
	const framesApi = {
		frames,
		replaceAll: setFrames
	} as unknown as FramesApi;
	const edgeAnchors = {
		overrides,
		replaceAll: setOverrides
	} as unknown as AnchorsApi;

	const history = useCanvasHistory({
		tablePositions,
		tableSizes,
		framesApi,
		hiddenIds,
		setHiddenIds
	});
	const { canvasReady } = useCanvasSyncBridge({
		connectionId: "conn-1",
		baseRef,
		setNodes,
		tablePositions,
		tableSizes,
		framesApi,
		edgeAnchors,
		hiddenIds,
		setHiddenIds,
		onHydrated: history.resetBaseline
	});
	return {
		history,
		canvasReady,
		state: { positions, sizes, frames, hiddenIds },
		setPositions
	};
}

const SERVER_PAYLOAD = {
	positions: {
		users: { x: 100, y: 200 },
		orders: { x: 400, y: 50 }
	},
	sizes: { users: { width: 320, height: 240 } },
	frames: [
		{
			key: "f1",
			label: "Core",
			hue: 210,
			collections: ["users", "orders"],
			rect: { x: 80, y: 30, width: 700, height: 420 }
		}
	],
	hidden: ["audit_log"]
};

let fetchMock: Mock;

beforeEach(() => {
	fetchMock = vi.fn();
	vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
	// Démonte tant que fetch est stubbé : le flush pré-unmount de
	// useCanvasSync partirait sinon sur le vrai réseau.
	cleanup();
	vi.unstubAllGlobals();
	vi.clearAllMocks();
});

describe("useCanvasSyncBridge × useCanvasHistory", () => {
	it("drag puis undo après hydratation serveur → layout hydraté intact", async () => {
		fetchMock.mockResolvedValue(
			mockResponse(200, {
				payload: SERVER_PAYLOAD,
				updatedAt: "2026-10-11T00:00:00.000Z"
			})
		);
		const { result } = renderHook(() => useWiring(), {
			wrapper: makeWrapper()
		});

		await waitFor(() => {
			expect(result.current.canvasReady).toBe(true);
		});
		expect(result.current.state.positions).toEqual(SERVER_PAYLOAD.positions);
		expect(result.current.history.canUndo).toBe(false);

		act(() => {
			result.current.setPositions((p) => ({
				...p,
				users: { x: 150, y: 260 }
			}));
			result.current.history.push();
		});
		act(() => {
			result.current.history.undo();
		});

		expect(result.current.state.positions).toEqual(SERVER_PAYLOAD.positions);
		expect(result.current.state.sizes).toEqual(SERVER_PAYLOAD.sizes);
		expect(result.current.state.frames).toEqual(SERVER_PAYLOAD.frames);
		expect(result.current.state.hiddenIds).toEqual(
			new Set(SERVER_PAYLOAD.hidden)
		);
	});
});
