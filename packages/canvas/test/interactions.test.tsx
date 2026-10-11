import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NestCanvas, type NestCanvasProps } from "../src/components/NestCanvas";
import { useStoreApi } from "../src/context";
import { applyNodeChanges, useOnSelectionChange } from "../src/hooks";
import type { CanvasStore } from "../src/store";
import {
	type Node,
	type NodeChange,
	type NodeProps,
	SelectionMode
} from "../src/types";

afterEach(async () => {
	cleanup();
	vi.useRealTimers();
	await new Promise((resolve) => setTimeout(resolve, 1));
});

type CardNode = Node<{ label: string }, "card">;
function Card({ data }: NodeProps<CardNode>) {
	return (
		<div>
			<span>{data.label}</span>
			<button
				type="button"
				className="nodrag"
				data-testid={`btn-${data.label}`}
			>
				x
			</button>
		</div>
	);
}
const nodeTypes = { card: Card };

const initial = (): CardNode[] => [
	{
		id: "a",
		type: "card",
		position: { x: 0, y: 0 },
		data: { label: "A" },
		width: 100,
		height: 50
	},
	{
		id: "b",
		type: "card",
		position: { x: 300, y: 0 },
		data: { label: "B" },
		width: 100,
		height: 50
	},
	{
		id: "f",
		type: "card",
		position: { x: 0, y: 300 },
		data: { label: "F" },
		width: 100,
		height: 50,
		selectable: false,
		deletable: false
	}
];

let storeRef: CanvasStore | null = null;
function Probe() {
	storeRef = useStoreApi();
	return null;
}
const store = () => {
	if (storeRef === null) throw new Error("Probe non monté");
	return storeRef;
};

/** Canvas contrôlé, comme SchemaCanvas : les changes reviennent par l'état. */
function Harness(
	props: Partial<NestCanvasProps<CardNode>> & {
		log: NodeChange[][];
		onSelection?: (ids: string[]) => void;
	}
) {
	const { log, onSelection, ...rest } = props;
	const [nodes, setNodes] = useState(initial);
	return (
		<NestCanvas<CardNode>
			nodes={nodes}
			nodeTypes={nodeTypes}
			onNodesChange={(changes) => {
				log.push(changes);
				setNodes((prev) => applyNodeChanges(changes, prev));
			}}
			selectionOnDrag
			panOnDrag={[1]}
			selectionMode={SelectionMode.Partial}
			multiSelectionKeyCode={["Shift", "Meta", "Control"]}
			{...rest}
		>
			<Probe />
			{onSelection ? <SelectionSpy onSelection={onSelection} /> : null}
		</NestCanvas>
	);
}

function SelectionSpy({
	onSelection
}: {
	onSelection: (ids: string[]) => void;
}) {
	const [handler] = useState(
		() =>
			({ nodes }: { nodes: Node[] }) =>
				onSelection(nodes.map((n) => n.id))
	);
	useOnSelectionChange({ onChange: handler });
	return null;
}

/** happy-dom ne fait pas de layout : on fixe les tailles DOM à la main. Un
 *  node jamais mesuré compte comme visible partout (lasso compris). */
function fakeMeasure(container: HTMLElement) {
	const els = Array.from(container.querySelectorAll<HTMLElement>(".nest-node"));
	for (const el of els) {
		Object.defineProperty(el, "offsetWidth", {
			configurable: true,
			value: 100
		});
		Object.defineProperty(el, "offsetHeight", {
			configurable: true,
			value: 50
		});
	}
	act(() => store().updateNodeDimensions(els));
}

const nodeEl = (c: HTMLElement, id: string) =>
	c.querySelector<HTMLElement>(`[data-id="${id}"]`) as HTMLElement;
const selected = () =>
	[...store().getState().nodeLookup.values()]
		.filter((n) => n.selected)
		.map((n) => n.id);

function mouse(target: EventTarget, type: string, init: MouseEventInit = {}) {
	act(() => {
		target.dispatchEvent(
			new MouseEvent(type, { bubbles: true, cancelable: true, ...init })
		);
	});
}

describe("clic et sélection", () => {
	it("clic : sélectionne seul, onNodeClick reçoit une copie du node", () => {
		const log: NodeChange[][] = [];
		const onNodeClick = vi.fn();
		const { container } = render(
			<Harness log={log} onNodeClick={onNodeClick} />
		);
		fireEvent.click(nodeEl(container, "a"));
		expect(selected()).toEqual(["a"]);
		expect(onNodeClick).toHaveBeenCalledTimes(1);
		const passed = onNodeClick.mock.calls[0]?.[1] as CardNode;
		expect(passed.id).toBe("a");
		fireEvent.click(nodeEl(container, "b"));
		expect(selected()).toEqual(["b"]);
		expect(nodeEl(container, "b").className).toContain("selected");
		expect(nodeEl(container, "b").style.zIndex).toBe("1000");
	});

	it("Cmd + clic : ajoute puis retire de la sélection", () => {
		const { container } = render(<Harness log={[]} />);
		fireEvent.click(nodeEl(container, "a"));
		fireEvent.keyDown(document, {
			key: "Meta",
			code: "MetaLeft",
			metaKey: true
		});
		fireEvent.click(nodeEl(container, "b"));
		expect(selected()).toEqual(["a", "b"]);
		fireEvent.click(nodeEl(container, "a"));
		expect(selected()).toEqual(["b"]);
		fireEvent.keyUp(document, { key: "Meta", code: "MetaLeft" });
	});

	it("node non sélectionnable : le clic ne sélectionne rien mais part quand même", () => {
		const onNodeClick = vi.fn();
		const { container } = render(
			<Harness log={[]} onNodeClick={onNodeClick} />
		);
		fireEvent.click(nodeEl(container, "f"));
		expect(selected()).toEqual([]);
		expect(onNodeClick).toHaveBeenCalledTimes(1);
	});

	it("double-clic et menu contextuel relayés avec le node", () => {
		const onNodeDoubleClick = vi.fn();
		const onNodeContextMenu = vi.fn();
		const { container } = render(
			<Harness
				log={[]}
				onNodeDoubleClick={onNodeDoubleClick}
				onNodeContextMenu={onNodeContextMenu}
			/>
		);
		fireEvent.doubleClick(nodeEl(container, "a"));
		fireEvent.contextMenu(nodeEl(container, "b"));
		expect((onNodeDoubleClick.mock.calls[0]?.[1] as CardNode).id).toBe("a");
		expect((onNodeContextMenu.mock.calls[0]?.[1] as CardNode).id).toBe("b");
	});

	it("useOnSelectionChange suit l'ensemble sélectionné", () => {
		const onSelection = vi.fn();
		const { container } = render(
			<Harness log={[]} onSelection={onSelection} />
		);
		fireEvent.click(nodeEl(container, "a"));
		expect(onSelection).toHaveBeenLastCalledWith(["a"]);
	});
});

describe("drag", () => {
	it("démarre au-delà de 1 px, émet positions puis dragging:false, avale le clic", () => {
		const log: NodeChange[][] = [];
		const onNodeDragStart = vi.fn();
		const onNodeDrag = vi.fn();
		const onNodeDragStop = vi.fn();
		const onNodeClick = vi.fn();
		const { container } = render(
			<Harness
				log={log}
				onNodeDragStart={onNodeDragStart}
				onNodeDrag={onNodeDrag}
				onNodeDragStop={onNodeDragStop}
				onNodeClick={onNodeClick}
			/>
		);
		const a = nodeEl(container, "a");
		mouse(a, "mousedown", { clientX: 10, clientY: 10 });
		mouse(window, "mousemove", { clientX: 10.5, clientY: 10.5 });
		expect(onNodeDragStart).not.toHaveBeenCalled();
		mouse(window, "mousemove", { clientX: 15, clientY: 10 });
		expect(onNodeDragStart).toHaveBeenCalledTimes(1);
		expect(selected()).toEqual(["a"]);
		mouse(window, "mousemove", { clientX: 40, clientY: 30 });
		expect(onNodeDrag).toHaveBeenCalled();
		expect(a.style.transform).toBe("translate(25px,20px)");
		expect(a.className).toContain("dragging");
		mouse(window, "mouseup", { clientX: 40, clientY: 30 });
		const last = log[log.length - 1];
		expect(last).toEqual([
			{ id: "a", type: "position", position: { x: 25, y: 20 }, dragging: false }
		]);
		expect(onNodeDragStop).toHaveBeenCalledTimes(1);
		const [, stopNode] = onNodeDragStop.mock.calls[0] as [MouseEvent, CardNode];
		expect(stopNode.position).toEqual({ x: 25, y: 20 });
		expect(stopNode.dragging).toBe(false);
		fireEvent.click(a);
		expect(onNodeClick).not.toHaveBeenCalled();
		expect(a.className).not.toContain("dragging");
	});

	it("mousedown accepté ne remonte pas ; sur .nodrag il remonte et rien ne bouge", () => {
		const { container } = render(<Harness log={[]} />);
		const parentDown = vi.fn();
		container.addEventListener("mousedown", parentDown);
		mouse(nodeEl(container, "a"), "mousedown", { clientX: 0, clientY: 0 });
		mouse(window, "mouseup");
		expect(parentDown).not.toHaveBeenCalled();
		const btn = container.querySelector('[data-testid="btn-A"]') as HTMLElement;
		mouse(btn, "mousedown", { clientX: 0, clientY: 0 });
		mouse(window, "mousemove", { clientX: 50, clientY: 0 });
		mouse(window, "mouseup");
		expect(parentDown).toHaveBeenCalledTimes(1);
		expect(nodeEl(container, "a").style.transform).toBe("translate(0px,0px)");
	});

	it("drag d'un node sélectionné : toute la sélection suit", () => {
		const { container } = render(<Harness log={[]} />);
		fireEvent.click(nodeEl(container, "a"));
		fireEvent.keyDown(document, {
			key: "Meta",
			code: "MetaLeft",
			metaKey: true
		});
		fireEvent.click(nodeEl(container, "b"));
		fireEvent.keyUp(document, { key: "Meta", code: "MetaLeft" });
		mouse(nodeEl(container, "b"), "mousedown", { clientX: 0, clientY: 0 });
		// Le déplacement compte depuis le franchissement du seuil (10, 5).
		mouse(window, "mousemove", { clientX: 10, clientY: 5 });
		mouse(window, "mousemove", { clientX: 20, clientY: 10 });
		mouse(window, "mouseup");
		expect(nodeEl(container, "a").style.transform).toBe("translate(10px,5px)");
		expect(nodeEl(container, "b").style.transform).toBe("translate(310px,5px)");
	});

	it("drag d'un node non sélectionnable : vide la sélection, déplace le node seul", () => {
		const { container } = render(<Harness log={[]} />);
		fireEvent.click(nodeEl(container, "a"));
		mouse(nodeEl(container, "f"), "mousedown", { clientX: 0, clientY: 0 });
		mouse(window, "mousemove", { clientX: 10, clientY: 0 });
		mouse(window, "mousemove", { clientX: 40, clientY: 0 });
		mouse(window, "mouseup");
		expect(selected()).toEqual([]);
		expect(nodeEl(container, "f").style.transform).toBe(
			"translate(30px,300px)"
		);
		expect(nodeEl(container, "a").style.transform).toBe("translate(0px,0px)");
	});
});

function pointer(
	target: EventTarget,
	type: string,
	init: PointerEventInit = {}
) {
	act(() => {
		target.dispatchEvent(
			new PointerEvent(type, {
				bubbles: true,
				cancelable: true,
				isPrimary: true,
				pointerId: 1,
				button: 0,
				...init
			})
		);
	});
}

describe("lasso et clic sur le vide", () => {
	it("glisser sur le vide sélectionne les nodes touchés (partiel)", () => {
		const onSelectionStart = vi.fn();
		const onSelectionEnd = vi.fn();
		const { container } = render(
			<Harness
				log={[]}
				onSelectionStart={onSelectionStart}
				onSelectionEnd={onSelectionEnd}
			/>
		);
		act(() => store().setState({ width: 1000, height: 800 }));
		fakeMeasure(container);
		const pane = container.querySelector(".nest-pane") as HTMLElement;
		pointer(pane, "pointerdown", { clientX: -10, clientY: -10 });
		pointer(pane, "pointermove", { clientX: -10.5, clientY: -10 });
		expect(onSelectionStart).not.toHaveBeenCalled();
		pointer(pane, "pointermove", { clientX: 320, clientY: 20 });
		expect(onSelectionStart).toHaveBeenCalledTimes(1);
		expect(container.querySelector(".nest-selection")).not.toBeNull();
		expect(selected()).toEqual(["a", "b"]);
		pointer(pane, "pointerup", { clientX: 320, clientY: 20 });
		expect(onSelectionEnd).toHaveBeenCalledTimes(1);
		expect(container.querySelector(".nest-selection")).toBeNull();
		expect(selected()).toEqual(["a", "b"]);
	});

	it("le lasso ignore les nodes non sélectionnables", () => {
		const { container } = render(<Harness log={[]} />);
		act(() => store().setState({ width: 1000, height: 800 }));
		fakeMeasure(container);
		const pane = container.querySelector(".nest-pane") as HTMLElement;
		pointer(pane, "pointerdown", { clientX: -5, clientY: 250 });
		pointer(pane, "pointermove", { clientX: 50, clientY: 320 });
		pointer(pane, "pointerup", { clientX: 50, clientY: 320 });
		expect(selected()).toEqual([]);
	});

	it("relâcher sans bouger sur le vide = clic : onPaneClick + désélection", () => {
		const onPaneClick = vi.fn();
		const { container } = render(
			<Harness log={[]} onPaneClick={onPaneClick} />
		);
		fireEvent.click(nodeEl(container, "a"));
		const pane = container.querySelector(".nest-pane") as HTMLElement;
		pointer(pane, "pointerdown", { clientX: 600, clientY: 600 });
		pointer(pane, "pointerup", { clientX: 600, clientY: 600 });
		expect(onPaneClick).toHaveBeenCalledTimes(1);
		expect(selected()).toEqual([]);
	});

	it("Shift + pointerdown sur un node : démarre un lasso, le node ne reçoit pas le geste", () => {
		const { container } = render(<Harness log={[]} />);
		fireEvent.keyDown(window, {
			key: "Shift",
			code: "ShiftLeft",
			shiftKey: true
		});
		const a = nodeEl(container, "a");
		const down = new PointerEvent("pointerdown", {
			bubbles: true,
			cancelable: true,
			isPrimary: true,
			pointerId: 1,
			button: 0,
			clientX: 10,
			clientY: 10
		});
		act(() => {
			a.dispatchEvent(down);
		});
		expect(down.defaultPrevented).toBe(true);
		expect(store().getState().userSelectionRect).not.toBeNull();
		fireEvent.keyUp(window, { key: "Shift", code: "ShiftLeft" });
	});
});

describe("clavier", () => {
	it("flèches : déplace la sélection de 5 px, ×4 avec Shift", () => {
		const log: NodeChange[][] = [];
		const { container } = render(<Harness log={log} />);
		const a = nodeEl(container, "a");
		fireEvent.click(a);
		fireEvent.keyDown(a, { key: "ArrowRight" });
		expect(log[log.length - 1]).toEqual([
			{ id: "a", type: "position", position: { x: 5, y: 0 }, dragging: false }
		]);
		fireEvent.keyDown(a, { key: "ArrowDown", shiftKey: true });
		expect(a.style.transform).toBe("translate(5px,20px)");
	});

	it("Échap désélectionne, Entrée sélectionne", () => {
		const { container } = render(<Harness log={[]} />);
		const a = nodeEl(container, "a");
		fireEvent.keyDown(a, { key: "Enter" });
		expect(selected()).toEqual(["a"]);
		fireEvent.keyDown(a, { key: "Escape" });
		expect(selected()).toEqual([]);
	});

	it("Backspace supprime les nodes sélectionnés supprimables", () => {
		const onNodesDelete = vi.fn();
		const log: NodeChange[][] = [];
		const { container } = render(
			<Harness log={log} onNodesDelete={onNodesDelete} />
		);
		fireEvent.click(nodeEl(container, "a"));
		act(() => store().selectExactly(new Set(["a", "f"])));
		fireEvent.keyDown(document, { key: "Backspace", code: "Backspace" });
		expect(
			(onNodesDelete.mock.calls[0]?.[0] as CardNode[]).map((n) => n.id)
		).toEqual(["a"]);
		expect(log[log.length - 1]).toEqual([{ id: "a", type: "remove" }]);
		expect(nodeEl(container, "a")).toBeNull();
		fireEvent.keyUp(document, { key: "Backspace", code: "Backspace" });
	});

	it("nodes focusables, décrits pour les lecteurs d'écran", () => {
		const { container } = render(<Harness log={[]} />);
		const a = nodeEl(container, "a");
		expect(a.tabIndex).toBe(0);
		expect(a.getAttribute("role")).toBe("group");
		const descId = a.getAttribute("aria-describedby") as string;
		expect(container.querySelector(`#${descId}`)).not.toBeNull();
	});
});
