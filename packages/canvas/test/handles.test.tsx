import { act, cleanup, render } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { Handle } from "../src/components/Handle";
import { NestCanvas } from "../src/components/NestCanvas";
import { useStoreApi } from "../src/context";
import { applyNodeChanges } from "../src/hooks";
import type { CanvasStore } from "../src/store";
import {
	type Node,
	type NodeChange,
	type NodeProps,
	Position
} from "../src/types";

afterEach(cleanup);

type PortNode = Node<{ ports: readonly string[] }, "ports">;
function Ports({ data }: NodeProps<PortNode>) {
	return (
		<div>
			{data.ports.map((port) => (
				<Handle key={port} id={port} type="source" position={Position.Right} />
			))}
		</div>
	);
}
const nodeTypes = { ports: Ports };

let storeRef: CanvasStore | null = null;
let setPorts: (ports: readonly string[]) => void = () => {};
function Probe() {
	storeRef = useStoreApi();
	return null;
}
const store = () => storeRef as CanvasStore;

function Harness({ log }: { log: NodeChange[][] }) {
	const [nodes, setNodes] = useState<PortNode[]>([
		{
			id: "n",
			type: "ports",
			position: { x: 0, y: 0 },
			data: { ports: ["p1"] },
			width: 200,
			height: 100
		}
	]);
	setPorts = (ports) =>
		setNodes((prev) => prev.map((node) => ({ ...node, data: { ports } })));
	return (
		<NestCanvas<PortNode>
			nodes={nodes}
			nodeTypes={nodeTypes}
			onNodesChange={(changes) => {
				log.push(changes);
				setNodes((prev) => applyNodeChanges(changes, prev));
			}}
		>
			<Probe />
		</NestCanvas>
	);
}

/** happy-dom ne fait pas de layout : la taille DOM est fixée à la main. */
function fakeMeasure(container: HTMLElement) {
	const el = container.querySelector<HTMLElement>(".nest-node") as HTMLElement;
	Object.defineProperty(el, "offsetWidth", { configurable: true, value: 200 });
	Object.defineProperty(el, "offsetHeight", { configurable: true, value: 100 });
	act(() => store().updateNodeDimensions([el]));
}

const measuredPorts = () =>
	store()
		.getState()
		.nodeLookup.get("n")
		?.internals.handleBounds?.source?.map((handle) => handle.id);

const flushMicrotasks = () => act(async () => {});

describe("handles montés après la mesure", () => {
	it("un node jamais mesuré n'est pas mesuré par ses handles", async () => {
		render(<Harness log={[]} />);
		await flushMicrotasks();
		expect(store().getState().nodeLookup.get("n")?.internals.measuredOnce).toBe(
			undefined
		);
	});

	it("handle ajouté sans changement de taille : connu du node", async () => {
		const log: NodeChange[][] = [];
		const { container } = render(<Harness log={log} />);
		fakeMeasure(container);
		expect(measuredPorts()).toEqual(["p1"]);
		const emitted = log.length;

		act(() => setPorts(["p1", "p2"]));
		await flushMicrotasks();
		expect(measuredPorts()).toEqual(["p1", "p2"]);
		expect(log.length).toBe(emitted);
	});

	it("handle retiré : oublié du node", async () => {
		const { container } = render(<Harness log={[]} />);
		fakeMeasure(container);
		act(() => setPorts(["p1", "p2"]));
		await flushMicrotasks();

		act(() => setPorts(["p2"]));
		await flushMicrotasks();
		expect(measuredPorts()).toEqual(["p2"]);
	});
});
