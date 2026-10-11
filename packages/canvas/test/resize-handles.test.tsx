import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Handle } from "../src/components/Handle";
import { NestCanvas } from "../src/components/NestCanvas";
import { NodeResizer } from "../src/components/NodeResizer";
import { useStoreApi } from "../src/context";
import { applyNodeChanges } from "../src/hooks";
import { getBezierPath } from "../src/paths";
import { dimensionsAfterResize } from "../src/resizer";
import type { CanvasStore } from "../src/store";
import {
	type HandleBound,
	type InternalNode,
	type Node,
	type NodeChange,
	type NodeProps,
	Position
} from "../src/types";

afterEach(async () => {
	cleanup();
	await new Promise((resolve) => setTimeout(resolve, 1));
});

describe("géométrie du resize", () => {
	const start = {
		x: 100,
		y: 50,
		width: 240,
		height: 120,
		pointerX: 0,
		pointerY: 0
	};
	const bounds = {
		minWidth: 200,
		maxWidth: 800,
		minHeight: 60,
		maxHeight: 1600
	};
	const dir = (p: string) => ({
		isHorizontal: p.includes("right") || p.includes("left"),
		isVertical: p.includes("bottom") || p.includes("top"),
		affectsX: p.includes("left"),
		affectsY: p.includes("top")
	});

	it("coin bas-droit : agrandit sans déplacer l'origine, distance arrondie vers le bas", () => {
		expect(
			dimensionsAfterResize(
				start,
				dir("bottom-right"),
				{ x: 30.9, y: 10.2 },
				bounds
			)
		).toEqual({
			x: 100,
			y: 50,
			width: 270,
			height: 130
		});
	});

	it("coin haut-gauche : déplace l'origine pour garder le bord opposé", () => {
		expect(
			dimensionsAfterResize(start, dir("top-left"), { x: -20, y: -15 }, bounds)
		).toEqual({
			x: 80,
			y: 35,
			width: 260,
			height: 135
		});
	});

	it("bornes min/max rognent le déplacement, bord droit seul n'agit qu'en largeur", () => {
		expect(
			dimensionsAfterResize(start, dir("left"), { x: 100, y: 999 }, bounds)
		).toEqual({
			x: 140,
			y: 50,
			width: 200,
			height: 120
		});
		expect(
			dimensionsAfterResize(start, dir("right"), { x: 9000, y: 0 }, bounds)
				.width
		).toBe(800);
	});
});

type BoxNode = Node<{ label: string }, "box">;
let storeRef: CanvasStore | null = null;
const store = () => {
	if (storeRef === null) throw new Error("store absent");
	return storeRef;
};
function Probe() {
	storeRef = useStoreApi();
	return null;
}

function Box({ id }: NodeProps<BoxNode>) {
	return (
		<div style={{ width: "100%", height: "100%" }}>
			<NodeResizer
				minWidth={200}
				maxWidth={800}
				minHeight={60}
				maxHeight={1600}
				onResizeEnd={(_, p) => onResizeEnd(id, p)}
				lineStyle={{ borderColor: "red" }}
			/>
			<Handle
				id={RIGHT}
				type="source"
				position={Position.Right}
				style={{ opacity: 0 }}
			/>
			<Handle
				id={RIGHT}
				type="target"
				position={Position.Right}
				style={{ opacity: 0 }}
			/>
		</div>
	);
}
const onResizeEnd = vi.fn();
const RIGHT = "right";
const nodeTypes = { box: Box };

function Harness({ log }: { log: NodeChange[][] }) {
	const [nodes, setNodes] = useState<BoxNode[]>([
		{
			id: "a",
			type: "box",
			position: { x: 100, y: 50 },
			data: { label: "A" },
			width: 240,
			height: 120,
			measured: { width: 240, height: 120 }
		},
		{
			id: "b",
			type: "box",
			position: { x: 500, y: 50 },
			data: { label: "B" },
			width: 240,
			height: 120,
			measured: { width: 240, height: 120 }
		}
	]);
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

function mouse(target: EventTarget, type: string, init: MouseEventInit = {}) {
	act(() => {
		target.dispatchEvent(
			new MouseEvent(type, { bubbles: true, cancelable: true, ...init })
		);
	});
}

describe("NodeResizer", () => {
	it("rend 4 bords + 4 coins, styles et mise à l'échelle des coins au dézoom", () => {
		const { container } = render(<Harness log={[]} />);
		const controls = container.querySelectorAll(
			'[data-id="a"] .nest-resize-control'
		);
		expect(controls).toHaveLength(8);
		const right = container.querySelector<HTMLElement>(
			'[data-id="a"] .nest-resize-control.line.right'
		);
		expect(right?.className).toBe("nest-resize-control nodrag right line");
		expect(right?.style.borderColor).toBe("red");
		act(() => store().setState({ transform: [0, 0, 0.25] }));
		const corner = container.querySelector<HTMLElement>(
			'[data-id="a"] .nest-resize-control.handle.bottom.right'
		);
		// happy-dom garde `scale` en propriété JS sans le refléter en CSS texte.
		const scaleOf = (el: HTMLElement | null | undefined) =>
			(el?.style as unknown as { scale?: string } | undefined)?.scale ?? "";
		expect(scaleOf(corner)).toBe("4");
		expect(scaleOf(right)).toBe("");
	});

	it("coin bas-droit : dimensions resizing puis final, onResizeEnd avec la géométrie", () => {
		const log: NodeChange[][] = [];
		onResizeEnd.mockClear();
		const { container } = render(<Harness log={log} />);
		const corner = container.querySelector(
			'[data-id="a"] .nest-resize-control.handle.bottom.right'
		) as HTMLElement;
		mouse(corner, "mousedown", { clientX: 340, clientY: 170 });
		mouse(window, "mousemove", { clientX: 380, clientY: 200 });
		expect(log[log.length - 1]).toEqual([
			{
				id: "a",
				type: "dimensions",
				resizing: true,
				setAttributes: true,
				dimensions: { width: 280, height: 150 }
			}
		]);
		mouse(window, "mouseup", { clientX: 380, clientY: 200 });
		expect(log[log.length - 1]).toEqual([
			{
				id: "a",
				type: "dimensions",
				resizing: false,
				dimensions: { width: 280, height: 150 }
			}
		]);
		expect(onResizeEnd).toHaveBeenCalledWith("a", {
			x: 100,
			y: 50,
			width: 280,
			height: 150
		});
		const node = container.querySelector<HTMLElement>('[data-id="a"]');
		expect(node?.style.width).toBe("280px");
	});

	it("coin haut-gauche : position puis dimensions ; le mousedown ne démarre pas de drag", () => {
		const log: NodeChange[][] = [];
		const { container } = render(<Harness log={log} />);
		const parentDown = vi.fn();
		container.addEventListener("mousedown", parentDown);
		const corner = container.querySelector(
			'[data-id="a"] .nest-resize-control.handle.top.left'
		) as HTMLElement;
		mouse(corner, "mousedown", { clientX: 100, clientY: 50 });
		mouse(window, "mousemove", { clientX: 80, clientY: 40 });
		mouse(window, "mouseup", { clientX: 80, clientY: 40 });
		expect(parentDown).not.toHaveBeenCalled();
		expect(log[0]).toEqual([
			{ id: "a", type: "position", position: { x: 80, y: 40 } },
			{
				id: "a",
				type: "dimensions",
				resizing: true,
				setAttributes: true,
				dimensions: { width: 260, height: 130 }
			}
		]);
	});

	it("Ctrl + mousedown : pas de resize", () => {
		const log: NodeChange[][] = [];
		const { container } = render(<Harness log={log} />);
		const corner = container.querySelector(
			'[data-id="a"] .nest-resize-control.handle.bottom.right'
		) as HTMLElement;
		mouse(corner, "mousedown", { clientX: 340, clientY: 170, ctrlKey: true });
		mouse(window, "mousemove", { clientX: 400, clientY: 220 });
		mouse(window, "mouseup", {});
		expect(
			log.filter((c) => c.some((x) => x.type === "dimensions" && x.resizing))
		).toHaveLength(0);
	});
});

/** happy-dom n'a pas de layout : conteneur 1200×800 et handles posés à la
 *  main (sinon un conteneur 0×0 déclenche l'auto-pan au bord). */
function placeHandles() {
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
	const lookup = store().getState().nodeLookup;
	for (const id of ["a", "b"]) {
		const node = lookup.get(id) as InternalNode;
		const right = (type: "source" | "target"): HandleBound => ({
			id: "right",
			type,
			nodeId: id,
			position: Position.Right,
			x: 237,
			y: 57,
			width: 6,
			height: 6
		});
		lookup.set(id, {
			...node,
			internals: {
				...node.internals,
				measuredOnce: true,
				handleBounds: { source: [right("source")], target: [right("target")] }
			}
		});
	}
}

describe("Handle et connexion", () => {
	it("classes, données et indicateur de connexion", () => {
		const { container } = render(<Harness log={[]} />);
		const h = container.querySelector<HTMLElement>(
			'[data-id="a"] .nest-handle.source'
		);
		expect(h?.className).toBe(
			"nest-handle nest-handle-right nodrag nopan source connectable connectablestart connectableend connectionindicator"
		);
		expect(h?.dataset.handleid).toBe("right");
		expect(h?.dataset.nodeid).toBe("a");
		expect(h?.dataset.handlepos).toBe("right");
		expect(h?.dataset.id).toBe(
			`${store().getState().instanceId}-a-right-source`
		);
	});

	it("drag depuis un handle : ligne de connexion qui suit, s'accroche, disparaît sans change", () => {
		const log: NodeChange[][] = [];
		const { container } = render(<Harness log={log} />);
		act(() => {
			store().setState({ width: 1200, height: 800 });
			placeHandles();
			store().setState({});
		});
		const from = container.querySelector(
			'[data-id="a"] .nest-handle.source'
		) as HTMLElement;
		mouse(from, "mousedown", { button: 0, clientX: 340, clientY: 110 });
		mouse(document, "mousemove", { clientX: 340.5, clientY: 110 });
		expect(store().getState().connection.inProgress).toBe(false);
		mouse(document, "mousemove", { clientX: 600, clientY: 300 });
		const c = store().getState().connection;
		expect(c.inProgress).toBe(true);
		expect(c.from).toEqual({ x: 340, y: 110 });
		expect(c.isValid).toBeNull();
		expect(
			container.querySelector(".nest-connectionline path")?.getAttribute("d")
		).toBe(
			getBezierPath({
				sourceX: 340,
				sourceY: 110,
				sourcePosition: Position.Right,
				targetX: 600,
				targetY: 300,
				targetPosition: Position.Left
			})[0]
		);
		// À 10 px du handle cible de b (740, 110) : accroche, ligne jusqu'à son centre.
		mouse(document, "mousemove", { clientX: 748, clientY: 116 });
		const snapped = store().getState().connection;
		expect(snapped.isValid).toBe(true);
		expect(snapped.toHandle?.nodeId).toBe("b");
		expect(snapped.toHandle?.type).toBe("target");
		expect(snapped.toPosition).toBe(Position.Right);
		mouse(document, "mouseup", {});
		expect(store().getState().connection.inProgress).toBe(false);
		expect(container.querySelector(".nest-connectionline")).toBeNull();
		expect(
			log.filter((c) => c.some((x) => x.type !== "dimensions"))
		).toHaveLength(0);
	});

	it("clic sur un handle arme une connexion au clic, un 2ᵉ clic la referme", () => {
		const { container } = render(<Harness log={[]} />);
		const a = container.querySelector(
			'[data-id="a"] .nest-handle.source'
		) as HTMLElement;
		const b = container.querySelector(
			'[data-id="b"] .nest-handle.target'
		) as HTMLElement;
		fireEvent.click(a);
		expect(store().getState().connectionClickStartHandle).toEqual({
			nodeId: "a",
			type: "source",
			id: "right"
		});
		expect(a.className).toContain("clickconnecting");
		fireEvent.click(b);
		expect(store().getState().connectionClickStartHandle).toBeNull();
	});

	it("un mousedown sur un handle ne démarre pas le drag du node", () => {
		const log: NodeChange[][] = [];
		const { container } = render(<Harness log={log} />);
		const h = container.querySelector(
			'[data-id="a"] .nest-handle.target'
		) as HTMLElement;
		mouse(h, "mousedown", { button: 0, clientX: 340, clientY: 110 });
		mouse(document, "mousemove", { clientX: 400, clientY: 160 });
		mouse(document, "mouseup", {});
		expect(
			log.filter((c) => c.some((x) => x.type === "position"))
		).toHaveLength(0);
	});
});

describe("mesure des handles", () => {
	it("la mesure DOM enregistre les handles par type, relatifs au node", () => {
		const { container } = render(<Harness log={[]} />);
		const el = container.querySelector<HTMLElement>(
			'[data-id="a"]'
		) as HTMLElement;
		Object.defineProperty(el, "offsetWidth", {
			configurable: true,
			value: 240
		});
		Object.defineProperty(el, "offsetHeight", {
			configurable: true,
			value: 120
		});
		act(() => store().updateNodeDimensions([el]));
		const bounds = store().getState().nodeLookup.get("a")
			?.internals.handleBounds;
		expect(bounds?.source?.map((h) => [h.id, h.type, h.position])).toEqual([
			["right", "source", "right"]
		]);
		expect(bounds?.target?.map((h) => [h.id, h.type, h.position])).toEqual([
			["right", "target", "right"]
		]);
	});
});
