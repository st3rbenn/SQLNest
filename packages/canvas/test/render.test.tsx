import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Background } from "../src/components/Background";
import { NestCanvas } from "../src/components/NestCanvas";
import { NestCanvasProvider } from "../src/components/NestCanvasProvider";
import { Panel } from "../src/components/Panel";
import { useStoreApi } from "../src/context";
import { viewportForBounds } from "../src/geometry";
import {
	type NestCanvasInstance,
	useNestCanvas,
	useViewport
} from "../src/hooks";
import type { CanvasStore } from "../src/store";
import { visibleNodeIds } from "../src/store";
import type { Node, NodeProps } from "../src/types";

afterEach(cleanup);

type CardNode = Node<{ label: string }, "card">;
function Card({ data, selected, width }: NodeProps<CardNode>) {
	return (
		<div
			data-testid={`card-${data.label}`}
			data-selected={selected}
			data-width={width}
		>
			{data.label}
		</div>
	);
}
const nodeTypes = { card: Card };

const nodes: CardNode[] = [
	{
		id: "a",
		type: "card",
		position: { x: 10, y: 20 },
		data: { label: "A" },
		width: 200,
		height: 100
	},
	{
		id: "b",
		type: "card",
		position: { x: 400, y: 300 },
		data: { label: "B" },
		width: 200,
		height: 100,
		selected: true,
		zIndex: 10
	}
];

let probed: { store: CanvasStore; instance: NestCanvasInstance } | null = null;
function Probe() {
	probed = { store: useStoreApi(), instance: useNestCanvas() };
	return null;
}
function api() {
	if (probed === null) throw new Error("Probe non monté");
	return probed;
}

/** happy-dom ne fait pas de layout : on fixe les tailles DOM à la main. */
function fakeMeasure(store: CanvasStore, container: HTMLElement) {
	const els = Array.from(container.querySelectorAll<HTMLElement>(".nest-node"));
	for (const el of els) {
		Object.defineProperty(el, "offsetWidth", {
			configurable: true,
			value: 200
		});
		Object.defineProperty(el, "offsetHeight", {
			configurable: true,
			value: 100
		});
	}
	act(() => store.updateNodeDimensions(els));
}

describe("NestCanvas", () => {
	it("rend les nodes positionnés, classes et z-index (sélection élevée de 1000)", () => {
		const { container, getByTestId } = render(
			<NestCanvas nodes={nodes} nodeTypes={nodeTypes} />
		);
		const a = container.querySelector<HTMLElement>('[data-id="a"]');
		const b = container.querySelector<HTMLElement>('[data-id="b"]');
		expect(a?.style.transform).toBe("translate(10px,20px)");
		expect(a?.className).toBe(
			"nest-node nest-node-card nopan selectable draggable"
		);
		expect(b?.className).toContain("selected");
		expect(b?.style.zIndex).toBe("1010");
		expect(a?.style.width).toBe("200px");
		expect(getByTestId("card-B").dataset.selected).toBe("true");
	});

	it("viewport par défaut borné par minZoom / maxZoom", () => {
		const { container } = render(
			<NestCanvas
				nodes={nodes}
				nodeTypes={nodeTypes}
				defaultViewport={{ x: 5, y: 6, zoom: 0.001 }}
				minZoom={0.02}
				maxZoom={1.75}
			/>
		);
		const vp = container.querySelector<HTMLElement>(".nest-viewport");
		expect(vp?.style.transform).toBe("translate(5px,6px) scale(0.02)");
	});

	it("la mesure DOM émet des changes `dimensions` vers onNodesChange", () => {
		const onNodesChange = vi.fn();
		const { container } = render(
			<NestCanvas
				nodes={nodes}
				nodeTypes={nodeTypes}
				onNodesChange={onNodesChange}
			>
				<Probe />
			</NestCanvas>
		);
		fakeMeasure(api().store, container);
		expect(onNodesChange).toHaveBeenCalledWith([
			{ id: "a", type: "dimensions", dimensions: { width: 200, height: 100 } },
			{ id: "b", type: "dimensions", dimensions: { width: 200, height: 100 } }
		]);
		expect(api().store.getState().nodesInitialized).toBe(false);
	});

	it("fitView attend la mesure puis cadre les nodes (padding 0.1)", async () => {
		vi.useFakeTimers({ toFake: ["requestAnimationFrame"] });
		const { container } = render(
			<NestCanvasProvider>
				<NestCanvas nodes={nodes} nodeTypes={nodeTypes} />
				<Probe />
			</NestCanvasProvider>
		);
		act(() => api().store.setState({ width: 1000, height: 600 }));
		act(() => {
			void api().instance.fitView();
		});
		vi.runAllTimers();
		expect(api().store.getState().transform).toEqual([0, 0, 1]);
		fakeMeasure(api().store, container);
		// Bornes mesurées [10,20]→[600,400] dans 1000×600, padding 0.1.
		const expected = viewportForBounds(
			{ x: 10, y: 20, width: 590, height: 380 },
			1000,
			600,
			0.5,
			2,
			0.1
		);
		expect(api().store.getState().transform).toEqual([
			expected.x,
			expected.y,
			expected.zoom
		]);
		vi.useRealTimers();
	});

	it("getNodes rend des copies, getNode le node user", () => {
		render(
			<NestCanvas nodes={nodes} nodeTypes={nodeTypes}>
				<Probe />
			</NestCanvas>
		);
		const list = api().instance.getNodes();
		expect(list).toEqual(nodes);
		expect(list[0]).not.toBe(nodes[0]);
		expect(api().instance.getNode("b")).toBe(nodes[1]);
	});

	it("culling : un node mesuré hors écran n'est plus rendu", () => {
		const { container } = render(
			<NestCanvas nodes={nodes} nodeTypes={nodeTypes} onlyRenderVisibleElements>
				<Probe />
			</NestCanvas>
		);
		fakeMeasure(api().store, container);
		act(() =>
			api().store.setState({ width: 300, height: 200, transform: [0, 0, 1] })
		);
		expect(visibleNodeIds(api().store.getState(), true)).toEqual(["a"]);
		expect(container.querySelector('[data-id="b"]')).toBeNull();
	});
});

describe("structure DOM", () => {
	it("calques et classes dans l'ordre de React Flow", () => {
		const { container } = render(
			<NestCanvas
				nodes={nodes}
				nodeTypes={nodeTypes}
				selectionOnDrag
				panOnDrag={[1]}
			>
				<Background />
				<Probe />
			</NestCanvas>
		);
		const root = container.firstElementChild as HTMLElement;
		expect(root.className).toBe("nest-canvas");
		expect(root.getAttribute("role")).toBe("application");
		const renderer = root.querySelector(".nest-renderer") as HTMLElement;
		const pane = renderer.firstElementChild as HTMLElement;
		// Pas de classe conteneur sur le pane : sa géométrie est en style inline.
		expect(pane.className).toBe("nest-pane selection");
		expect(pane.style.position).toBe("absolute");
		expect(pane.style.width).toBe("100%");
		const viewport = pane.firstElementChild as HTMLElement;
		expect(viewport.className).toBe("nest-viewport nest-container");
		expect(Array.from(viewport.children).map((c) => c.className)).toEqual([
			"nest-edges",
			"nest-edgelabel-renderer",
			"nest-nodes",
			"nest-viewport-portal"
		]);
		const pattern = root.querySelector("pattern") as SVGPatternElement;
		expect(pattern.id).toBe("pattern-1");
	});

	it("préfixe des ids : l'id du canvas, « 1 » par défaut, à chaque montage", () => {
		const first = render(
			<NestCanvas>
				<Probe />
			</NestCanvas>
		);
		expect(api().store.getState().instanceId).toBe("1");
		first.unmount();
		const second = render(
			<NestCanvas>
				<Probe />
			</NestCanvas>
		);
		expect(api().store.getState().instanceId).toBe("1");
		second.unmount();
		render(
			<NestCanvas id="schema">
				<Probe />
			</NestCanvas>
		);
		expect(api().store.getState().instanceId).toBe("schema");
	});
});

function ZoomLabel() {
	const { zoom } = useViewport();
	return <span data-testid="zoom">{zoom}</span>;
}

describe("Background, Panel, useViewport", () => {
	it("motif de points aligné sur la transform", () => {
		const { container } = render(
			<NestCanvas defaultViewport={{ x: 35, y: -12, zoom: 0.5 }}>
				<Background color="red" gap={20} />
			</NestCanvas>
		);
		const pattern = container.querySelector("pattern");
		expect(pattern?.getAttribute("width")).toBe("10");
		expect(pattern?.getAttribute("x")).toBe(String(35 % 10));
		expect(pattern?.getAttribute("y")).toBe(String(-12 % 10));
		expect(pattern?.getAttribute("patternTransform")).toBe("translate(-6,-6)");
		expect(container.querySelector("circle")?.getAttribute("r")).toBe("0.25");
	});

	it("Panel porte ses classes de position, useViewport suit le zoom", () => {
		const { container, getByTestId } = render(
			<NestCanvas defaultViewport={{ x: 0, y: 0, zoom: 1.5 }}>
				<Panel position="bottom-center">
					<ZoomLabel />
				</Panel>
			</NestCanvas>
		);
		expect(container.querySelector(".nest-panel")?.className).toBe(
			"nest-panel bottom center"
		);
		expect(getByTestId("zoom").textContent).toBe("1.5");
	});
});
