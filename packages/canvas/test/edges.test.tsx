import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { EdgeLabelRenderer } from "../src/components/EdgeLabelRenderer";
import { NestCanvas } from "../src/components/NestCanvas";
import { useStoreApi } from "../src/context";
import { applyNodeChanges } from "../src/hooks";
import type { CanvasStore } from "../src/store";
import {
	type Edge,
	type EdgeProps,
	type HandleBound,
	type InternalNode,
	MarkerType,
	type Node,
	type NodeChange,
	type NodeProps,
	Position
} from "../src/types";

afterEach(async () => {
	cleanup();
	await new Promise((resolve) => setTimeout(resolve, 1));
});

let storeRef: CanvasStore | null = null;
const store = () => {
	if (storeRef === null) throw new Error("store absent");
	return storeRef;
};
function Probe() {
	storeRef = useStoreApi();
	return null;
}

type BoxNode = Node<{ label: string }, "box">;
function Box({ data }: NodeProps<BoxNode>) {
	return <div>{data.label}</div>;
}
const nodeTypes = { box: Box };

const received: EdgeProps[] = [];
function Fk(props: EdgeProps) {
	received.push(props);
	return (
		<>
			<path
				d={`M${props.sourceX},${props.sourceY}L${props.targetX},${props.targetY}`}
				className="nest-edge-path"
				markerEnd={props.markerEnd}
			/>
			<EdgeLabelRenderer>
				<div data-testid={`label-${props.id}`} />
			</EdgeLabelRenderer>
		</>
	);
}
const edgeTypes = { fk: Fk };

const initialNodes: BoxNode[] = [
	{
		id: "a",
		type: "box",
		position: { x: 100, y: 50 },
		data: { label: "A" },
		width: 240,
		height: 120,
		measured: { width: 240, height: 120 },
		selected: true
	},
	{
		id: "b",
		type: "box",
		position: { x: 500, y: 300 },
		data: { label: "B" },
		width: 240,
		height: 120,
		measured: { width: 240, height: 120 }
	}
];

const fkEdge: Edge = {
	id: "e1",
	source: "a",
	target: "b",
	type: "fk",
	sourceHandle: "right",
	targetHandle: "left",
	markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
	style: { stroke: "#0d99ff", strokeWidth: 1.5 },
	data: { inferred: false }
};

function Harness({
	edges,
	log,
	onlyRenderVisibleElements = false
}: {
	edges: Edge[];
	log: NodeChange[][];
	onlyRenderVisibleElements?: boolean;
}) {
	const [nodes, setNodes] = useState<BoxNode[]>(initialNodes);
	return (
		<NestCanvas<BoxNode>
			nodes={nodes}
			edges={edges}
			nodeTypes={nodeTypes}
			edgeTypes={edgeTypes}
			onlyRenderVisibleElements={onlyRenderVisibleElements}
			onNodesChange={(changes) => {
				log.push(changes);
				setNodes((prev) => applyNodeChanges(changes, prev));
			}}
		>
			<Probe />
		</NestCanvas>
	);
}

/** Handles mesurés à la main (happy-dom sans layout) : 4 côtés, source et cible. */
function placeHandles() {
	const lookup = store().getState().nodeLookup;
	for (const id of ["a", "b"]) {
		const node = lookup.get(id) as InternalNode;
		const handles = (type: "source" | "target"): HandleBound[] =>
			[Position.Top, Position.Right, Position.Bottom, Position.Left].map(
				(position) => ({
					id: position,
					type,
					nodeId: id,
					position,
					x:
						position === Position.Left
							? -3
							: position === Position.Right
								? 237
								: 117,
					y:
						position === Position.Top
							? -3
							: position === Position.Bottom
								? 117
								: 57,
					width: 6,
					height: 6
				})
			);
		lookup.set(id, {
			...node,
			internals: {
				...node.internals,
				measuredOnce: true,
				handleBounds: { source: handles("source"), target: handles("target") }
			}
		});
	}
	store().setState({});
}

describe("EdgeRenderer", () => {
	it("n'affiche un edge qu'une fois les handles mesurés", () => {
		const { container } = render(<Harness edges={[fkEdge]} log={[]} />);
		expect(container.querySelector(".nest-edge")).toBeNull();
		act(placeHandles);
		expect(container.querySelector(".nest-edge")).not.toBeNull();
	});

	it("wrapper SVG, classes, a11y et z-index de l'edge", () => {
		const { container } = render(
			<Harness edges={[{ ...fkEdge, zIndex: 10 }]} log={[]} />
		);
		act(placeHandles);
		const g = container.querySelector<SVGGElement>(".nest-edge");
		const svg = g?.parentElement as unknown as SVGSVGElement;
		expect(svg.tagName.toLowerCase()).toBe("svg");
		expect(svg.parentElement?.className).toBe("nest-edges");
		expect(svg.style.zIndex).toBe("10");
		expect(g?.getAttribute("class")).toBe(
			"nest-edge nest-edge-fk nopan selectable"
		);
		expect(g?.getAttribute("tabindex")).toBe("0");
		expect(g?.getAttribute("role")).toBe("group");
		expect(g?.getAttribute("aria-roledescription")).toBe("edge");
		expect(g?.getAttribute("aria-label")).toBe("Edge de a vers b");
		const instanceId = store().getState().instanceId;
		expect(g?.getAttribute("aria-describedby")).toBe(
			`nest-edge-desc-${instanceId}`
		);
		expect(
			container.querySelector(`#nest-edge-desc-${instanceId}`)?.textContent
		).toContain("sélectionner un edge");
	});

	it("props de l'edge : extrémités sur les handles, positions, marker, style, data", () => {
		received.length = 0;
		render(<Harness edges={[fkEdge]} log={[]} />);
		act(placeHandles);
		const props = received[received.length - 1] as EdgeProps;
		expect(props).toMatchObject({
			id: "e1",
			source: "a",
			target: "b",
			// Bord extérieur du handle, qui déborde de 3 px du node.
			sourceX: 343,
			sourceY: 110,
			targetX: 497,
			targetY: 360,
			sourcePosition: Position.Right,
			targetPosition: Position.Left,
			sourceHandleId: "right",
			targetHandleId: "left",
			selectable: true,
			deletable: true,
			style: fkEdge.style,
			data: fkEdge.data,
			markerEnd: `url('#${store().getState().instanceId}__height=14&type=arrowclosed&width=14')`
		});
		expect(props.markerStart).toBeUndefined();
	});

	it("un edge suit son node quand l'app le déplace", () => {
		received.length = 0;
		render(<Harness edges={[fkEdge]} log={[]} />);
		act(placeHandles);
		act(() =>
			store().triggerNodeChanges([
				{ id: "b", type: "position", position: { x: 600, y: 400 } }
			])
		);
		const props = received[received.length - 1] as EdgeProps;
		expect({ x: props.targetX, y: props.targetY }).toEqual({ x: 597, y: 460 });
	});

	it("définitions de markers partagées, couleur par défaut", () => {
		const { container } = render(
			<Harness
				edges={[fkEdge, { ...fkEdge, id: "e2", source: "b", target: "a" }]}
				log={[]}
			/>
		);
		act(placeHandles);
		const markers = container.querySelectorAll("svg.nest-marker marker");
		expect(markers).toHaveLength(1);
		const marker = markers[0] as SVGMarkerElement;
		expect(marker.getAttribute("class")).toBe("nest-arrowhead");
		expect(marker.id).toBe(
			`${store().getState().instanceId}__height=14&type=arrowclosed&width=14`
		);
		expect(marker.getAttribute("markerWidth")).toBe("14");
		expect(marker.getAttribute("markerHeight")).toBe("14");
		expect(marker.getAttribute("viewBox")).toBe("-10 -10 20 20");
		expect(marker.getAttribute("markerUnits")).toBe("strokeWidth");
		expect(marker.getAttribute("orient")).toBe("auto-start-reverse");
		const polyline = marker.querySelector("polyline") as SVGPolylineElement;
		expect(polyline.getAttribute("class")).toBe("arrowclosed");
		expect(polyline.getAttribute("points")).toBe("-5,-4 0,0 -5,4 -5,-4");
		expect(polyline.getAttribute("style")).toContain("stroke: #b1b1b7");
		expect(polyline.getAttribute("style")).toContain("fill: #b1b1b7");
		expect(polyline.getAttribute("style")).toContain("stroke-width: 1");
	});

	it("edge masqué, type inconnu ou node absent : rien n'est rendu", () => {
		const { container } = render(
			<Harness
				edges={[
					{ ...fkEdge, hidden: true },
					{ ...fkEdge, id: "e2", type: "inconnu" },
					{ ...fkEdge, id: "e3", target: "zzz" }
				]}
				log={[]}
			/>
		);
		act(placeHandles);
		expect(container.querySelector(".nest-edge")).toBeNull();
	});

	it("onlyRenderVisibleElements : edge rendu seulement si la boîte de ses nodes touche l'écran", () => {
		const { container } = render(
			<Harness edges={[fkEdge]} log={[]} onlyRenderVisibleElements />
		);
		act(() => {
			placeHandles();
			store().setState({ width: 1200, height: 800, transform: [0, 0, 1] });
		});
		expect(container.querySelector(".nest-edge")).not.toBeNull();
		act(() => store().setState({ transform: [-5000, 0, 1] }));
		expect(container.querySelector(".nest-edge")).toBeNull();
		act(() => store().setState({ transform: [-400, -200, 1] }));
		expect(container.querySelector(".nest-edge")).not.toBeNull();
	});

	it("clic sur un edge : désélectionne les nodes, sauf en multi-sélection", () => {
		const log: NodeChange[][] = [];
		const { container } = render(<Harness edges={[fkEdge]} log={log} />);
		act(placeHandles);
		act(() => store().setState({ multiSelectionActive: true }));
		fireEvent.click(container.querySelector(".nest-edge") as Element);
		expect(log).toHaveLength(0);
		act(() => store().setState({ multiSelectionActive: false }));
		fireEvent.click(container.querySelector(".nest-edge") as Element);
		expect(log).toEqual([[{ id: "a", type: "select", selected: false }]]);
	});

	it("clavier sur un edge : Échap désélectionne les nodes", () => {
		const log: NodeChange[][] = [];
		const { container } = render(<Harness edges={[fkEdge]} log={log} />);
		act(placeHandles);
		fireEvent.keyDown(container.querySelector(".nest-edge") as Element, {
			key: "Escape"
		});
		expect(log).toEqual([[{ id: "a", type: "select", selected: false }]]);
	});

	it("EdgeLabelRenderer : portail dans le calque des labels, entre edges et nodes", () => {
		const { container, getByTestId } = render(
			<Harness edges={[fkEdge]} log={[]} />
		);
		act(placeHandles);
		const label = getByTestId("label-e1");
		const layer = label.parentElement as HTMLElement;
		expect(layer.className).toBe("nest-edgelabel-renderer");
		const viewport = container.querySelector(".nest-viewport") as HTMLElement;
		const order = Array.from(viewport.children).map((c) =>
			c.getAttribute("class")
		);
		expect(order.indexOf("nest-edges")).toBeLessThan(
			order.indexOf("nest-edgelabel-renderer")
		);
		expect(order.indexOf("nest-edgelabel-renderer")).toBeLessThan(
			order.indexOf("nest-nodes")
		);
	});
});
