import { act, cleanup, render } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Handle } from "../src/components/Handle";
import { NestCanvas } from "../src/components/NestCanvas";
import { NodeResizer } from "../src/components/NodeResizer";
import { useStoreApi } from "../src/context";
import { applyNodeChanges } from "../src/hooks";
import {
	createPanZoom,
	type PanZoom,
	type PanZoomOptions
} from "../src/panZoom";
import { type CanvasStore, createCanvasStore } from "../src/store";
import {
	type HandleBound,
	type InternalNode,
	type Node,
	type NodeChange,
	Position,
	type Transform
} from "../src/types";

const SQLNEST: PanZoomOptions = {
	panOnScroll: true,
	panOnScrollSpeed: 0.5,
	zoomOnScroll: false,
	zoomOnPinch: true,
	zoomOnDoubleClick: true,
	panOnDrag: [1],
	zoomActivationKeyPressed: false,
	userSelectionActive: false,
	connectionInProgress: false,
	clickDistance: Number.POSITIVE_INFINITY
};

/** Un doigt : identifiant + position client. */
type Finger = [id: number, x: number, y: number];

function touchEvent(
	target: Element,
	type: string,
	touches: Finger[],
	changed: Finger[]
): TouchEvent {
	const toTouch = ([identifier, clientX, clientY]: Finger) =>
		new Touch({ identifier, target, clientX, clientY });
	const event = new TouchEvent(type, {
		bubbles: true,
		cancelable: true,
		touches: touches.map(toTouch),
		changedTouches: changed.map(toTouch)
	});
	act(() => {
		target.dispatchEvent(event);
	});
	return event;
}

let store: CanvasStore;
let el: HTMLDivElement;
let panZoom: PanZoom;

function setup(
	transform: Transform = [0, 0, 1],
	options: Partial<PanZoomOptions> = {}
) {
	store = createCanvasStore({ minZoom: 0.02, maxZoom: 1.75, transform });
	store.setState({ width: 1000, height: 600 });
	el = document.createElement("div");
	document.body.appendChild(el);
	panZoom = createPanZoom(el, store);
	panZoom.update({ ...SQLNEST, ...options });
}
const t = () => store.getState().transform;

describe("viewport tactile (sémantique d3-zoom)", () => {
	afterEach(async () => {
		panZoom.destroy();
		el.remove();
		vi.useRealTimers();
		await new Promise((resolve) => setTimeout(resolve, 1));
	});

	it("un doigt déplace la vue, le point touché reste sous le doigt", () => {
		setup([10, 20, 0.5]);
		const start = touchEvent(
			el,
			"touchstart",
			[[1, 100, 100]],
			[[1, 100, 100]]
		);
		expect(start.defaultPrevented).toBe(false);
		const move = touchEvent(el, "touchmove", [[1, 150, 130]], [[1, 150, 130]]);
		expect(move.defaultPrevented).toBe(true);
		expect(t()).toEqual([60, 50, 0.5]);
		touchEvent(el, "touchend", [], [[1, 150, 130]]);
		touchEvent(el, "touchmove", [[1, 300, 300]], [[1, 300, 300]]);
		expect(t()).toEqual([60, 50, 0.5]);
	});

	it("deux doigts : zoom = écart écran / écart flow, milieu fixé", () => {
		setup([0, 0, 1]);
		touchEvent(el, "touchstart", [[1, 100, 100]], [[1, 100, 100]]);
		touchEvent(
			el,
			"touchstart",
			[
				[1, 100, 100],
				[2, 200, 100]
			],
			[[2, 200, 100]]
		);
		touchEvent(
			el,
			"touchmove",
			[
				[1, 50, 100],
				[2, 250, 100]
			],
			[
				[1, 50, 100],
				[2, 250, 100]
			]
		);
		// Écart écran 200, écart flow 100 → zoom 2 borné à maxZoom 1,75.
		const [x, y, k] = t();
		expect(k).toBe(1.75);
		expect((150 - x) / k).toBeCloseTo(150, 9);
		expect((100 - y) / k).toBeCloseTo(100, 9);
		// Un doigt levé : l'autre reprend le pan depuis là où il est.
		touchEvent(el, "touchend", [[2, 250, 100]], [[1, 50, 100]]);
		touchEvent(el, "touchmove", [[2, 260, 110]], [[2, 260, 110]]);
		expect(t()).toEqual([x + 10, y + 10, 1.75]);
	});

	it("double-tap : zoom ×2 autour du doigt en 250 ms", () => {
		vi.useFakeTimers({
			toFake: [
				"requestAnimationFrame",
				"cancelAnimationFrame",
				"performance",
				"setTimeout",
				"clearTimeout"
			]
		});
		setup([0, 0, 0.5]);
		touchEvent(el, "touchstart", [[1, 200, 100]], [[1, 200, 100]]);
		touchEvent(el, "touchend", [], [[1, 200, 100]]);
		vi.advanceTimersByTime(120);
		touchEvent(el, "touchstart", [[2, 203, 102]], [[2, 203, 102]]);
		const end = touchEvent(el, "touchend", [], [[2, 203, 102]]);
		expect(end.defaultPrevented).toBe(true);
		vi.advanceTimersByTime(300);
		const [x, y, k] = t();
		expect(k).toBe(1);
		expect((203 - x) / k).toBeCloseTo(406, 9);
		expect((102 - y) / k).toBeCloseTo(204, 9);
	});

	it("deux taps trop espacés (temps ou distance) : pas de zoom", () => {
		vi.useFakeTimers({
			toFake: ["requestAnimationFrame", "performance", "setTimeout"]
		});
		setup([0, 0, 0.5]);
		touchEvent(el, "touchstart", [[1, 200, 100]], [[1, 200, 100]]);
		touchEvent(el, "touchend", [], [[1, 200, 100]]);
		vi.advanceTimersByTime(600);
		touchEvent(el, "touchstart", [[2, 200, 100]], [[2, 200, 100]]);
		touchEvent(el, "touchend", [], [[2, 200, 100]]);
		vi.advanceTimersByTime(100);
		touchEvent(el, "touchstart", [[3, 230, 100]], [[3, 230, 100]]);
		touchEvent(el, "touchend", [], [[3, 230, 100]]);
		vi.advanceTimersByTime(400);
		expect(t()).toEqual([0, 0, 0.5]);
	});

	it("la souris émulée après un toucher est ignorée 500 ms", () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		setup([0, 0, 1], { panOnDrag: true });
		touchEvent(el, "touchstart", [[1, 10, 10]], [[1, 10, 10]]);
		touchEvent(el, "touchend", [], [[1, 10, 10]]);
		const fire = (type: string, x: number) =>
			act(() => {
				(type === "mousedown" ? el : window).dispatchEvent(
					new MouseEvent(type, {
						bubbles: true,
						cancelable: true,
						clientX: x,
						clientY: 10,
						button: 0
					})
				);
			});
		fire("mousedown", 10);
		fire("mousemove", 60);
		fire("mouseup", 60);
		expect(t()).toEqual([0, 0, 1]);
		vi.advanceTimersByTime(501);
		fire("mousedown", 10);
		fire("mousemove", 60);
		fire("mouseup", 60);
		expect(t()).toEqual([50, 0, 1]);
	});

	it("filtre : nopan, pinch désactivé, connexion en cours", () => {
		setup([0, 0, 1]);
		const node = document.createElement("div");
		node.className = "nest-node nopan";
		el.appendChild(node);
		touchEvent(node, "touchstart", [[1, 10, 10]], [[1, 10, 10]]);
		touchEvent(node, "touchmove", [[1, 60, 10]], [[1, 60, 10]]);
		expect(t()).toEqual([0, 0, 1]);
		panZoom.update({ ...SQLNEST, zoomOnPinch: false });
		const two = touchEvent(
			el,
			"touchstart",
			[
				[2, 10, 10],
				[3, 50, 10]
			],
			[
				[2, 10, 10],
				[3, 50, 10]
			]
		);
		expect(two.defaultPrevented).toBe(true);
		touchEvent(el, "touchmove", [[2, 60, 10]], [[2, 60, 10]]);
		expect(t()).toEqual([0, 0, 1]);
		touchEvent(el, "touchend", [], [[2, 60, 10]]);
		panZoom.update({ ...SQLNEST, connectionInProgress: true });
		touchEvent(el, "touchstart", [[4, 10, 10]], [[4, 10, 10]]);
		touchEvent(el, "touchmove", [[4, 60, 10]], [[4, 60, 10]]);
		expect(t()).toEqual([0, 0, 1]);
	});
});

type BoxNode = Node<{ label: string }, "box">;
let storeRef: CanvasStore | null = null;
function Probe() {
	storeRef = useStoreApi();
	return null;
}
const canvasStore = () => storeRef as CanvasStore;

/** happy-dom sans layout : conteneur 1200×800, sinon tout est « au bord » et
 *  l'auto-pan démarre. */
function sizeContainer() {
	act(() => canvasStore().setState({ width: 1200, height: 800 }));
	const domNode = canvasStore().getState().domNode as HTMLDivElement;
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

function Box() {
	return (
		<div style={{ width: "100%", height: "100%" }}>
			<NodeResizer minWidth={100} minHeight={50} />
			<Handle id={RIGHT} type="source" position={Position.Right} />
			<Handle id={LEFT} type="target" position={Position.Left} />
		</div>
	);
}
const RIGHT = "right";
const LEFT = "left";
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

describe("nodes au doigt (sémantique d3-drag)", () => {
	afterEach(async () => {
		cleanup();
		await new Promise((resolve) => setTimeout(resolve, 1));
	});

	it("un doigt déplace le node ; le toucher ne remonte pas au viewport", () => {
		const log: NodeChange[][] = [];
		const { container } = render(<Harness log={log} />);
		sizeContainer();
		const node = container.querySelector('[data-id="a"]') as HTMLElement;
		expect(node.style.touchAction).toBe("none");
		const parent = vi.fn();
		container.addEventListener("touchstart", parent);
		touchEvent(node, "touchstart", [[1, 200, 100]], [[1, 200, 100]]);
		expect(parent).not.toHaveBeenCalled();
		// Le mouvement qui franchit le seuil démarre le drag sans déplacer.
		touchEvent(node, "touchmove", [[1, 210, 100]], [[1, 210, 100]]);
		touchEvent(node, "touchmove", [[1, 240, 120]], [[1, 240, 120]]);
		touchEvent(node, "touchend", [], [[1, 240, 120]]);
		const positions = log
			.flat()
			.filter((c) => c.type === "position") as Extract<
			NodeChange,
			{ type: "position" }
		>[];
		expect(positions[positions.length - 1]).toEqual({
			id: "a",
			type: "position",
			position: { x: 130, y: 70 },
			dragging: false
		});
		expect(canvasStore().getState().transform).toEqual([0, 0, 1]);
	});

	it("un deuxième doigt annule le drag et termine sur dragging: false", () => {
		const log: NodeChange[][] = [];
		const { container } = render(<Harness log={log} />);
		sizeContainer();
		const node = container.querySelector('[data-id="a"]') as HTMLElement;
		touchEvent(node, "touchstart", [[1, 200, 100]], [[1, 200, 100]]);
		touchEvent(node, "touchmove", [[1, 210, 100]], [[1, 210, 100]]);
		touchEvent(node, "touchmove", [[1, 220, 100]], [[1, 220, 100]]);
		const before = log.length;
		touchEvent(
			node,
			"touchstart",
			[
				[1, 220, 100],
				[2, 260, 100]
			],
			[[2, 260, 100]]
		);
		touchEvent(
			node,
			"touchmove",
			[
				[1, 300, 100],
				[2, 340, 100]
			],
			[
				[1, 300, 100],
				[2, 340, 100]
			]
		);
		expect(log.length).toBe(before);
		touchEvent(node, "touchend", [[1, 300, 100]], [[2, 340, 100]]);
		expect(log[log.length - 1]).toEqual([
			{
				id: "a",
				type: "position",
				position: { x: 110, y: 50 },
				dragging: false
			}
		]);
	});

	it("resize au doigt depuis un coin", () => {
		const log: NodeChange[][] = [];
		const { container } = render(<Harness log={log} />);
		const corner = container.querySelector(
			'[data-id="a"] .nest-resize-control.handle.bottom.right'
		) as HTMLElement;
		expect(corner.style.touchAction).toBe("none");
		touchEvent(corner, "touchstart", [[1, 340, 170]], [[1, 340, 170]]);
		touchEvent(corner, "touchmove", [[1, 380, 200]], [[1, 380, 200]]);
		touchEvent(corner, "touchend", [], [[1, 380, 200]]);
		expect(log[log.length - 1]).toEqual([
			{
				id: "a",
				type: "dimensions",
				resizing: false,
				dimensions: { width: 280, height: 150 }
			}
		]);
	});

	it("connexion au doigt : un doigt levé parmi deux ne la termine pas", () => {
		const { container } = render(<Harness log={[]} />);
		sizeContainer();
		act(() => {
			const lookup = canvasStore().getState().nodeLookup;
			for (const id of ["a", "b"]) {
				const node = lookup.get(id) as InternalNode;
				const handle = (type: "source" | "target", x: number): HandleBound => ({
					id: type === "source" ? "right" : "left",
					type,
					nodeId: id,
					position: type === "source" ? Position.Right : Position.Left,
					x,
					y: 57,
					width: 6,
					height: 6
				});
				lookup.set(id, {
					...node,
					internals: {
						...node.internals,
						measuredOnce: true,
						handleBounds: {
							source: [handle("source", 237)],
							target: [handle("target", -3)]
						}
					}
				});
			}
			canvasStore().setState({});
		});
		const from = container.querySelector(
			'[data-id="a"] .nest-handle.source'
		) as HTMLElement;
		touchEvent(from, "touchstart", [[1, 340, 110]], [[1, 340, 110]]);
		touchEvent(document.body, "touchmove", [[1, 500, 200]], [[1, 500, 200]]);
		expect(canvasStore().getState().connection.inProgress).toBe(true);
		touchEvent(document.body, "touchend", [[2, 10, 10]], [[1, 500, 200]]);
		expect(canvasStore().getState().connection.inProgress).toBe(true);
		touchEvent(document.body, "touchend", [], [[2, 10, 10]]);
		expect(canvasStore().getState().connection.inProgress).toBe(false);
	});
});
