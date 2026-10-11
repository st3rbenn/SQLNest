import { act, cleanup, render } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { NestCanvas } from "../src/components/NestCanvas";
import { useStoreApi } from "../src/context";
import { applyNodeChanges } from "../src/hooks";
import type { CanvasStore } from "../src/store";
import type { Node, NodeChange, NodeProps } from "../src/types";

afterEach(async () => {
	cleanup();
	await new Promise((resolve) => setTimeout(resolve, 1));
});

type BoxNode = Node<{ label: string }, "frame" | "table">;
let storeRef: CanvasStore | null = null;
function Probe() {
	storeRef = useStoreApi();
	return null;
}
const store = () => storeRef as CanvasStore;

function Box({ data }: NodeProps<BoxNode>) {
	return <div style={{ width: "100%", height: "100%" }}>{data.label}</div>;
}
const nodeTypes = { frame: Box, table: Box };

const frame = (
	id: string,
	x: number,
	y: number,
	width: number,
	height: number,
	parentId?: string
): BoxNode => ({
	id,
	type: "frame",
	position: { x, y },
	data: { label: id },
	width,
	height,
	measured: { width, height },
	zIndex: -1,
	clipChildren: true,
	...(parentId ? { parentId, expandParent: true } : {})
});
const table = (
	id: string,
	x: number,
	y: number,
	parentId?: string
): BoxNode => ({
	id,
	type: "table",
	position: { x, y },
	data: { label: id },
	width: 100,
	height: 60,
	measured: { width: 100, height: 60 },
	...(parentId ? { parentId, expandParent: true } : {})
});

const canReparent = (node: BoxNode, parent: BoxNode | null) =>
	(node.type === "table" || node.type === "frame") &&
	(parent === null || parent.type === "frame");

function Harness({
	log,
	initial,
	reparent = true
}: {
	log: NodeChange[][];
	initial: BoxNode[];
	reparent?: boolean;
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
			{...(reparent ? { canReparent } : {})}
			panOnDrag={[1]}
			selectionOnDrag
		>
			<Probe />
		</NestCanvas>
	);
}

function sizeContainer() {
	act(() => store().setState({ width: 2000, height: 1500 }));
	const domNode = store().getState().domNode as HTMLDivElement;
	domNode.getBoundingClientRect = () =>
		({
			left: 0,
			top: 0,
			x: 0,
			y: 0,
			width: 2000,
			height: 1500,
			right: 2000,
			bottom: 1500
		}) as DOMRect;
}

function mouse(target: EventTarget, type: string, init: MouseEventInit = {}) {
	act(() => {
		target.dispatchEvent(
			new MouseEvent(type, { bubbles: true, cancelable: true, ...init })
		);
	});
}

const el = (container: HTMLElement, id: string) =>
	container.querySelector<HTMLElement>(`[data-id="${id}"]`) as HTMLElement;

/** Drag souris de `id` par le point `from` jusqu'à `to`, en étapes. */
function drag(
	container: HTMLElement,
	id: string,
	from: [number, number],
	to: [number, number],
	options: { release?: boolean } = {}
) {
	const node = el(container, id);
	mouse(node, "mousedown", { button: 0, clientX: from[0], clientY: from[1] });
	mouse(window, "mousemove", { clientX: from[0] + 2, clientY: from[1] });
	const steps = 6;
	for (let i = 1; i <= steps; i++) {
		mouse(window, "mousemove", {
			clientX: from[0] + 2 + ((to[0] - from[0] - 2) * i) / steps,
			clientY: from[1] + ((to[1] - from[1]) * i) / steps
		});
	}
	if (options.release !== false) {
		mouse(window, "mouseup", { clientX: to[0], clientY: to[1] });
	}
}

const parentChanges = (log: NodeChange[][]) =>
	log.flat().filter((c) => c.type === "parent") as Extract<
		NodeChange,
		{ type: "parent" }
	>[];

describe("re-parentage au pointeur", () => {
	it("d'un frame à l'autre : change `parent`, aucun saut à l'écran", () => {
		const log: NodeChange[][] = [];
		const { container } = render(
			<Harness
				log={log}
				initial={[
					frame("A", 0, 0, 400, 400),
					frame("B", 600, 0, 400, 400),
					table("t", 50, 50, "A")
				]}
			/>
		);
		sizeContainer();
		drag(container, "t", [60, 60], [700, 100]);
		const last = parentChanges(log).at(-1);
		expect(last).toMatchObject({ id: "t", parentId: "B" });
		// Décalage pointeur → coin pris au franchissement du seuil : (12, 10).
		expect(el(container, "t").style.transform).toBe("translate(688px,90px)");
		expect(last?.position).toEqual({ x: 88, y: 90 });
	});

	it("frame visé surligné pendant le geste, plus après", () => {
		const log: NodeChange[][] = [];
		const { container } = render(
			<Harness
				log={log}
				initial={[
					frame("A", 0, 0, 400, 400),
					frame("B", 600, 0, 400, 400),
					table("t", 50, 50, "A")
				]}
			/>
		);
		sizeContainer();
		drag(container, "t", [60, 60], [700, 100], { release: false });
		expect(el(container, "B").classList.contains("drop-target")).toBe(true);
		expect(el(container, "A").classList.contains("drop-target")).toBe(false);
		mouse(window, "mouseup", { clientX: 700, clientY: 100 });
		expect(el(container, "B").classList.contains("drop-target")).toBe(false);
	});

	it("sorti de tout frame : rattaché à la racine, position absolue", () => {
		const log: NodeChange[][] = [];
		const { container } = render(
			<Harness
				log={log}
				initial={[frame("A", 0, 0, 400, 400), table("t", 50, 50, "A")]}
			/>
		);
		sizeContainer();
		drag(container, "t", [60, 60], [900, 600]);
		const last = parentChanges(log).at(-1);
		expect(last).toMatchObject({ id: "t", parentId: null });
		const node = store().getState().nodeLookup.get("t");
		expect(node?.parentId).toBeUndefined();
		expect(node?.position).toEqual(node?.internals.positionAbsolute);
	});

	it("le conteneur le plus profond l'emporte ; un frame ne vise ni lui-même ni ses descendants", () => {
		const log: NodeChange[][] = [];
		const { container } = render(
			<Harness
				log={log}
				initial={[
					frame("A", 0, 0, 800, 800),
					frame("inner", 300, 300, 300, 300, "A"),
					table("t", 20, 20, "A"),
					frame("C", 1000, 0, 300, 300)
				]}
			/>
		);
		sizeContainer();
		drag(container, "t", [30, 30], [400, 400]);
		expect(parentChanges(log).at(-1)).toMatchObject({
			id: "t",
			parentId: "inner"
		});
		log.length = 0;
		// Glisser le frame A sur lui-même : aucun changement de parent.
		drag(container, "A", [700, 50], [720, 60]);
		expect(parentChanges(log)).toHaveLength(0);
		// Glisser C dans A : C devient enfant de A.
		drag(container, "C", [1010, 10], [100, 600]);
		expect(parentChanges(log).at(-1)).toMatchObject({ id: "C", parentId: "A" });
	});

	it("sans `canReparent` : jamais de changement de parent (comportement RF)", () => {
		const log: NodeChange[][] = [];
		const { container } = render(
			<Harness
				log={log}
				reparent={false}
				initial={[
					frame("A", 0, 0, 400, 400),
					frame("B", 600, 0, 400, 400),
					table("t", 50, 50, "A")
				]}
			/>
		);
		sizeContainer();
		drag(container, "t", [60, 60], [700, 100]);
		expect(parentChanges(log)).toHaveLength(0);
	});
});

describe("agrandissement pendant le geste", () => {
	it("poussée contre le bord : le frame grandit ; pointeur sorti : il reprend sa taille", () => {
		const log: NodeChange[][] = [];
		const { container } = render(
			<Harness
				log={log}
				initial={[frame("A", 0, 0, 400, 400), table("t", 250, 50, "A")]}
			/>
		);
		sizeContainer();
		// Saisie à droite de la table, pointeur encore dans le frame.
		drag(container, "t", [340, 60], [398, 60], { release: false });
		expect(el(container, "A").style.width).not.toBe("400px");
		// Le pointeur sort : la table quitte le frame, qui revient à 400.
		mouse(window, "mousemove", { clientX: 600, clientY: 60 });
		mouse(window, "mouseup", { clientX: 600, clientY: 60 });
		expect(el(container, "A").style.width).toBe("400px");
		expect(store().getState().nodeLookup.get("t")?.parentId).toBeUndefined();
	});

	it("poussée à gauche puis sortie : frame et voisins reviennent à leur place", () => {
		const log: NodeChange[][] = [];
		const { container } = render(
			<Harness
				log={log}
				initial={[
					frame("A", 200, 0, 400, 400),
					table("t", 20, 50, "A"),
					table("u", 200, 200, "A")
				]}
			/>
		);
		sizeContainer();
		drag(container, "t", [300, 60], [210, 60], { release: false });
		expect(el(container, "A").style.transform).not.toBe("translate(200px,0px)");
		expect(el(container, "u").style.transform).toBe("translate(400px,200px)");
		mouse(window, "mousemove", { clientX: 100, clientY: 60 });
		mouse(window, "mouseup", { clientX: 100, clientY: 60 });
		expect(el(container, "A").style.transform).toBe("translate(200px,0px)");
		expect(el(container, "A").style.width).toBe("400px");
		expect(el(container, "u").style.transform).toBe("translate(400px,200px)");
	});
});

describe("rognage clipChildren", () => {
	it("un enfant qui dépasse est rogné au bord du frame ; un enfant entièrement dedans ne l'est pas", () => {
		const { container } = render(
			<Harness
				log={[]}
				initial={[
					frame("A", 0, 0, 300, 300),
					table("in", 10, 10, "A"),
					table("out", 250, 10, "A")
				]}
			/>
		);
		expect(el(container, "in").style.clipPath).toBe("");
		expect(el(container, "out").style.clipPath).toBe(
			"polygon(-250px -10px, 50px -10px, 50px 290px, -250px 290px)"
		);
	});

	it("frames imbriqués : intersection des zones qui rognent", () => {
		const { container } = render(
			<Harness
				log={[]}
				initial={[
					frame("A", 0, 0, 300, 300),
					frame("inner", 200, 200, 300, 300, "A"),
					table("t", 50, 50, "inner")
				]}
			/>
		);
		// t en (250, 250) absolu ; A s'arrête à 300, inner commence à 200.
		expect(el(container, "t").style.clipPath).toBe(
			"polygon(-50px -50px, 50px -50px, 50px 50px, -50px 50px)"
		);
	});
});
