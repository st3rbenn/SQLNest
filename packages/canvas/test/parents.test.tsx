import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { NestCanvas } from "../src/components/NestCanvas";
import { NodeResizer } from "../src/components/NodeResizer";
import { useStoreApi } from "../src/context";
import { applyNodeChanges } from "../src/hooks";
import {
	calculateNodePosition,
	handleExpandParent,
	type ParentLookup
} from "../src/parents";
import { type CanvasStore, createCanvasStore } from "../src/store";
import type { InternalNode, Node, NodeChange, NodeProps } from "../src/types";
import { parityInputs } from "./parityInputs";

const fixtures = JSON.parse(
	readFileSync(
		join(dirname(fileURLToPath(import.meta.url)), "fixtures/parents.json"),
		"utf8"
	)
);

const sortChanges = (changes: NodeChange[]) =>
	[...changes].sort((a, b) =>
		`${"id" in a ? a.id : ""}${a.type}`.localeCompare(
			`${"id" in b ? b.id : ""}${b.type}`
		)
	);

describe("parité parent / enfant (React Flow figé)", () => {
	const { forests } = parityInputs();

	it("positions absolues et z des enfants = adoptUserNodes RF", () => {
		forests.forEach((forest, i) => {
			const store = createCanvasStore({
				minZoom: 0.5,
				maxZoom: 2,
				transform: [0, 0, 1]
			});
			store.setNodes(structuredClone(forest.nodes));
			const lookup = store.getState().nodeLookup;
			forest.nodes.forEach((n, k) => {
				const internal = lookup.get(n.id) as InternalNode;
				expect([
					internal.internals.positionAbsolute.x,
					internal.internals.positionAbsolute.y,
					internal.internals.z
				]).toEqual(fixtures.forests[i].internals[k]);
			});
		});
	});

	it("calculateNodePosition = calculateNodePosition RF", () => {
		forests.forEach((forest, i) => {
			const store = createCanvasStore({
				minZoom: 0.5,
				maxZoom: 2,
				transform: [0, 0, 1]
			});
			store.setNodes(structuredClone(forest.nodes));
			const lookup = store.getState().nodeLookup;
			forest.moves.forEach((m, k) => {
				const r = calculateNodePosition(
					lookup.get(m.id) as InternalNode,
					m.next,
					lookup
				);
				expect([
					r.position.x,
					r.position.y,
					r.positionAbsolute.x,
					r.positionAbsolute.y
				]).toEqual(fixtures.forests[i].moves[k]);
			});
		});
	});

	it("handleExpandParent (un niveau) = handleExpandParent RF", () => {
		forests.forEach((forest, i) => {
			const store = createCanvasStore({
				minZoom: 0.5,
				maxZoom: 2,
				transform: [0, 0, 1]
			});
			// Sans `expandParent` sur les parents : RF n'agrandit qu'un niveau.
			store.setNodes(
				structuredClone(forest.nodes).map((n) => ({
					...n,
					expandParent: false
				}))
			);
			const { nodeLookup, parentLookup } = store.getState();
			const cases = forest.expand.filter((e) => nodeLookup.get(e.id)?.parentId);
			cases.forEach((e, k) => {
				const parentId = nodeLookup.get(e.id)?.parentId as string;
				expect(
					sortChanges(
						handleExpandParent(
							[{ id: e.id, parentId, rect: e.rect }],
							nodeLookup,
							parentLookup as ParentLookup
						)
					)
				).toEqual(sortChanges(fixtures.forests[i].expand[k]));
			});
		});
	});
});

describe("agrandissement en chaîne", () => {
	it("un frame agrandi agrandit son parent, sa position relative suit", () => {
		const store = createCanvasStore({
			minZoom: 0.5,
			maxZoom: 2,
			transform: [0, 0, 1]
		});
		store.setNodes([
			{
				id: "outer",
				position: { x: 0, y: 0 },
				data: {},
				measured: { width: 500, height: 500 }
			},
			{
				id: "inner",
				parentId: "outer",
				expandParent: true,
				position: { x: 50, y: 50 },
				data: {},
				measured: { width: 200, height: 200 }
			},
			{
				id: "sibling",
				parentId: "outer",
				position: { x: 300, y: 300 },
				data: {},
				measured: { width: 100, height: 100 }
			},
			{
				id: "table",
				parentId: "inner",
				expandParent: true,
				position: { x: 10, y: 10 },
				data: {},
				measured: { width: 100, height: 100 }
			}
		]);
		const { nodeLookup, parentLookup } = store.getState();
		// La table part à gauche, au-delà des deux frames.
		const changes = handleExpandParent(
			[
				{
					id: "table",
					parentId: "inner",
					rect: { x: -100, y: 60, width: 100, height: 100 }
				}
			],
			nodeLookup,
			parentLookup
		);
		const byKey = new Map(
			changes.map((c) => [`${"id" in c ? c.id : ""}:${c.type}`, c])
		);
		// inner s'étend de 150 à gauche : -100 en absolu, donc 0 dans outer
		// qui s'étend lui-même de 100.
		expect(byKey.get("inner:dimensions")).toMatchObject({
			dimensions: { width: 350, height: 200 }
		});
		expect(byKey.get("outer:position")).toMatchObject({
			position: { x: -100, y: 0 }
		});
		expect(byKey.get("outer:dimensions")).toMatchObject({
			dimensions: { width: 600, height: 500 }
		});
		expect(byKey.get("inner:position")).toMatchObject({
			position: { x: 0, y: 50 }
		});
		// Le voisin dans outer est décalé pour rester en place à l'écran.
		expect(byKey.get("sibling:position")).toMatchObject({
			position: { x: 400, y: 300 }
		});
	});
});

type BoxNode = Node<{ label: string }, "box">;
let storeRef: CanvasStore | null = null;
function Probe() {
	storeRef = useStoreApi();
	return null;
}
const store = () => storeRef as CanvasStore;

function Box({ data }: NodeProps<BoxNode>) {
	return (
		<div style={{ width: "100%", height: "100%" }}>
			<NodeResizer minWidth={50} minHeight={50} />
			{data.label}
		</div>
	);
}
const nodeTypes = { box: Box };

const tree: BoxNode[] = [
	{
		id: "frame",
		type: "box",
		position: { x: 100, y: 100 },
		data: { label: "F" },
		width: 600,
		height: 400,
		measured: { width: 600, height: 400 },
		zIndex: -1
	},
	{
		id: "a",
		type: "box",
		parentId: "frame",
		expandParent: true,
		position: { x: 50, y: 50 },
		data: { label: "A" },
		width: 200,
		height: 100,
		measured: { width: 200, height: 100 }
	},
	{
		id: "b",
		type: "box",
		parentId: "frame",
		position: { x: 300, y: 200 },
		data: { label: "B" },
		width: 200,
		height: 100,
		measured: { width: 200, height: 100 }
	}
];

function Harness({
	log,
	initial = tree
}: {
	log: NodeChange[][];
	initial?: BoxNode[];
}) {
	const [nodes, setNodes] = useState<BoxNode[]>(initial);
	return (
		<NestCanvas<BoxNode>
			nodes={nodes}
			nodeTypes={nodeTypes}
			onNodesChange={(changes) => {
				log.push(changes);
				setNodes((prev) => applyNodeChanges(changes, prev));
			}}
			panOnDrag={[1]}
			selectionOnDrag
		>
			<Probe />
		</NestCanvas>
	);
}

function sizeContainer() {
	act(() => store().setState({ width: 1200, height: 800 }));
	const domNode = store().getState().domNode as HTMLDivElement;
	domNode.getBoundingClientRect = () =>
		({
			left: 0,
			top: 0,
			x: 0,
			y: 0,
			width: 1200,
			height: 800,
			right: 1200,
			bottom: 800
		}) as DOMRect;
}

function mouse(target: EventTarget, type: string, init: MouseEventInit = {}) {
	act(() => {
		target.dispatchEvent(
			new MouseEvent(type, { bubbles: true, cancelable: true, ...init })
		);
	});
}

const transformOf = (container: HTMLElement, id: string) =>
	container.querySelector<HTMLElement>(`[data-id="${id}"]`)?.style.transform;

describe("parent / enfant au rendu", () => {
	afterEach(async () => {
		cleanup();
		await new Promise((resolve) => setTimeout(resolve, 1));
	});

	it("enfants positionnés depuis le parent, au-dessus de lui", () => {
		const { container } = render(<Harness log={[]} />);
		expect(transformOf(container, "a")).toBe("translate(150px,150px)");
		expect(transformOf(container, "b")).toBe("translate(400px,300px)");
		const z = (id: string) =>
			container.querySelector<HTMLElement>(`[data-id="${id}"]`)?.style.zIndex;
		expect(z("frame")).toBe("-1");
		expect(z("a")).toBe("0");
	});

	it("glisser le parent emmène ses enfants sans change pour eux", () => {
		const log: NodeChange[][] = [];
		const { container } = render(<Harness log={log} />);
		sizeContainer();
		const frame = container.querySelector('[data-id="frame"]') as HTMLElement;
		mouse(frame, "mousedown", { button: 0, clientX: 110, clientY: 110 });
		mouse(window, "mousemove", { clientX: 120, clientY: 110 });
		mouse(window, "mousemove", { clientX: 160, clientY: 140 });
		mouse(window, "mouseup", { clientX: 160, clientY: 140 });
		const moved = new Set(
			log
				.flat()
				.filter((c) => c.type === "position")
				.map((c) => (c as { id: string }).id)
		);
		expect([...moved]).toEqual(["frame"]);
		expect(transformOf(container, "frame")).toBe("translate(140px,130px)");
		expect(transformOf(container, "a")).toBe("translate(190px,180px)");
	});

	it("glisser un enfant : position relative au parent", () => {
		const log: NodeChange[][] = [];
		const { container } = render(<Harness log={log} />);
		sizeContainer();
		const b = container.querySelector('[data-id="b"]') as HTMLElement;
		mouse(b, "mousedown", { button: 0, clientX: 450, clientY: 320 });
		mouse(window, "mousemove", { clientX: 460, clientY: 320 });
		mouse(window, "mousemove", { clientX: 480, clientY: 340 });
		mouse(window, "mouseup", { clientX: 480, clientY: 340 });
		const last = log[log.length - 1]?.[0];
		expect(last).toEqual({
			id: "b",
			type: "position",
			position: { x: 320, y: 220 },
			dragging: false
		});
	});

	it("parent et enfant sélectionnés : seul le parent est déplacé", () => {
		const log: NodeChange[][] = [];
		const initial = tree.map((n) =>
			n.id === "frame" || n.id === "b" ? { ...n, selected: true } : n
		);
		const { container } = render(<Harness log={log} initial={initial} />);
		sizeContainer();
		const frame = container.querySelector('[data-id="frame"]') as HTMLElement;
		mouse(frame, "mousedown", { button: 0, clientX: 110, clientY: 110 });
		mouse(window, "mousemove", { clientX: 120, clientY: 110 });
		mouse(window, "mousemove", { clientX: 150, clientY: 110 });
		mouse(window, "mouseup", { clientX: 150, clientY: 110 });
		const moved = new Set(
			log
				.flat()
				.filter((c) => c.type === "position")
				.map((c) => (c as { id: string }).id)
		);
		expect([...moved]).toEqual(["frame"]);
	});

	it("enfant poussé au-delà du bord droit : le parent s'agrandit", () => {
		const log: NodeChange[][] = [];
		const { container } = render(<Harness log={log} />);
		sizeContainer();
		const a = container.querySelector('[data-id="a"]') as HTMLElement;
		mouse(a, "mousedown", { button: 0, clientX: 200, clientY: 160 });
		mouse(window, "mousemove", { clientX: 210, clientY: 160 });
		mouse(window, "mousemove", { clientX: 760, clientY: 160 });
		const flat = log.flat();
		expect(
			flat.filter(
				(c) => c.type === "dimensions" && (c as { id: string }).id === "frame"
			)
		).not.toHaveLength(0);
		mouse(window, "mouseup", { clientX: 760, clientY: 160 });
		const frame = container.querySelector<HTMLElement>('[data-id="frame"]');
		expect(frame?.style.width).toBe("800px");
	});

	it("enfant poussé au-delà du bord gauche : le parent s'étend, les autres enfants ne bougent pas", () => {
		const log: NodeChange[][] = [];
		const { container } = render(<Harness log={log} />);
		sizeContainer();
		const a = container.querySelector('[data-id="a"]') as HTMLElement;
		mouse(a, "mousedown", { button: 0, clientX: 200, clientY: 160 });
		mouse(window, "mousemove", { clientX: 190, clientY: 160 });
		mouse(window, "mousemove", { clientX: 100, clientY: 160 });
		mouse(window, "mouseup", { clientX: 100, clientY: 160 });
		// Décalage pointeur → coin pris au franchissement du seuil (x = 190).
		expect(transformOf(container, "frame")).toBe("translate(60px,100px)");
		expect(transformOf(container, "a")).toBe("translate(60px,150px)");
		expect(transformOf(container, "b")).toBe("translate(400px,300px)");
	});

	it("resize du parent par le coin haut-gauche : les enfants restent en place", () => {
		const log: NodeChange[][] = [];
		const { container } = render(<Harness log={log} />);
		sizeContainer();
		const corner = container.querySelector(
			'[data-id="frame"] > div > .nest-resize-control.handle.top.left'
		) as HTMLElement;
		mouse(corner, "mousedown", { clientX: 100, clientY: 100 });
		mouse(window, "mousemove", { clientX: 60, clientY: 80 });
		mouse(window, "mouseup", { clientX: 60, clientY: 80 });
		expect(transformOf(container, "frame")).toBe("translate(60px,80px)");
		expect(transformOf(container, "a")).toBe("translate(150px,150px)");
		expect(transformOf(container, "b")).toBe("translate(400px,300px)");
	});

	it("Backspace sur un parent supprime aussi ses enfants supprimables", () => {
		const log: NodeChange[][] = [];
		const initial = tree.map((n) =>
			n.id === "frame"
				? { ...n, selected: true }
				: n.id === "b"
					? { ...n, deletable: false }
					: n
		);
		render(<Harness log={log} initial={initial} />);
		fireEvent.keyDown(document.body, { key: "Backspace" });
		const removed = log
			.flat()
			.filter((c) => c.type === "remove")
			.map((c) => (c as { id: string }).id);
		expect(removed).toEqual(["frame", "a"]);
	});
});
