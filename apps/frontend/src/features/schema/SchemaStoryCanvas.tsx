import "@sqlnest/canvas/style.css";
import "./canvas-overrides.css";

import {
	applyNodeChanges,
	type Edge,
	NestCanvas,
	type Node
} from "@sqlnest/canvas";
import { useState } from "react";
import { relationEdges } from "./canvas/relationEdge";
import { bestHandles } from "./edgeRouting";
import { FrameNode } from "./FrameNode";
import type { Frame } from "./frames";
import { InteractiveEdge } from "./InteractiveEdge";
import type { SchemaModel } from "./schema-model";
import { NODE_WIDTH, nodeHeight, TableNode } from "./TableNode";

const nodeTypes = { table: TableNode, frame: FrameNode };
const edgeTypes = { fk: InteractiveEdge };

const COLUMN_GAP = 140;
const ROW_GAP = 60;
const COLUMNS = 2;

export interface SchemaStoryCanvasProps {
	readonly schema: SchemaModel;
	/** Tables à afficher ; toutes par défaut. */
	readonly tables?: readonly string[];
	readonly frames?: readonly Frame[];
	readonly focused?: string;
	readonly dimmed?: readonly string[];
	readonly withEdges?: boolean;
	readonly height?: number;
}

/**
 * Canvas de démonstration pour les stories : les tables d'un schéma posées
 * en grille, leurs relations, et des frames. Aucune persistance, aucun
 * appel réseau.
 */
export function SchemaStoryCanvas({
	schema,
	tables,
	frames = [],
	focused,
	dimmed = [],
	withEdges = true,
	height = 520
}: SchemaStoryCanvasProps) {
	const shown = schema.collections.filter(
		(c) => tables === undefined || tables.includes(c.name)
	);
	const [nodes, setNodes] = useState<Node[]>(() => [
		...frames.flatMap((frame): Node[] =>
			frame.rect === undefined
				? []
				: [
						{
							id: `frame:${frame.key}`,
							type: "frame",
							position: { x: frame.rect.x, y: frame.rect.y },
							width: frame.rect.width,
							height: frame.rect.height,
							data: { frame }
						}
					]
		),
		...shown.map(
			(collection, i): Node => ({
				id: collection.name,
				type: "table",
				position: {
					x: (i % COLUMNS) * (NODE_WIDTH + COLUMN_GAP),
					y: Math.floor(i / COLUMNS) * (nodeHeight(collection) + ROW_GAP)
				},
				width: NODE_WIDTH,
				height: nodeHeight(collection),
				data: {
					collection,
					dimmed: dimmed.includes(collection.name),
					focused: focused === collection.name,
					matched: false
				}
			})
		)
	]);

	const rectOf = (id: string) => {
		const node = nodes.find((n) => n.id === id);
		return node === undefined
			? undefined
			: {
					x: node.position.x,
					y: node.position.y,
					width: node.width ?? NODE_WIDTH,
					height: node.height ?? 0
				};
	};
	const edges: Edge[] = withEdges
		? relationEdges({ ...schema, collections: shown }).flatMap((edge) => {
				const source = rectOf(edge.source);
				const target = rectOf(edge.target);
				if (source === undefined || target === undefined) return [];
				const sides = bestHandles(source, target);
				return [
					{ ...edge, sourceHandle: sides.source, targetHandle: sides.target }
				];
			})
		: [];

	return (
		<div style={{ height, background: "var(--sqlnest-canvas-bg)" }}>
			<NestCanvas
				nodes={nodes}
				edges={edges}
				nodeTypes={nodeTypes}
				edgeTypes={edgeTypes}
				onNodesChange={(changes) =>
					setNodes((prev) => applyNodeChanges(changes, prev))
				}
				defaultViewport={{ x: 80, y: 100, zoom: 1 }}
				minZoom={0.2}
				maxZoom={1.75}
			/>
		</div>
	);
}
