import { type NodeChange, useNodesState } from "@sqlnest/canvas";
import { useCallback, useEffect, useRef } from "react";
import type { LayoutResult } from "../layout";
import type { SchemaModel } from "../schema-model";
import {
	fullNodeHeight,
	NODE_WIDTH,
	nodeHeight,
	type TableNodeType,
	tableAriaLabel
} from "../TableNode";
import type { FramesApi } from "../useFrames";
import type { PositionsApi, XY } from "../useTablePositions";
import type { SizesApi } from "../useTableSizes";
import { applyCanvasChanges } from "./frameTree";

export interface UseCanvasNodesOptions {
	readonly base: LayoutResult | null;
	/** Schéma courant : relu après un changement, il met à jour les colonnes des tables. */
	readonly schema: SchemaModel;
	readonly tablePositions: PositionsApi;
	readonly tableSizes: SizesApi;
	readonly framesApi: FramesApi;
	readonly history: { readonly push: () => void };
}

export interface UseCanvasNodesReturn {
	/** State des nodes — filtré + décoré par le parent avant d'être passé
	 * à `<NestCanvas>`. */
	readonly nodes: TableNodeType[];
	/** Setter direct — exposé car `useCanvasSync.replaceAll.{positions,sizes}`
	 * et `useCanvasSelection` en ont besoin pour repush le state à
	 * l'hydratation server ou au multi-select. */
	readonly setNodes: React.Dispatch<React.SetStateAction<TableNodeType[]>>;
	/** Version RAF de nodes — pour les closures qui ont besoin de la dernière
	 * position sans se refermer sur une snapshot obsolète (`handleFrameResize`
	 * qui inspecte les centres des tables membres, `handleSelectionEnd`, …). */
	readonly nodesRef: React.MutableRefObject<TableNodeType[]>;
	/** Handler à passer à `<NestCanvas onNodesChange={...}>`. Ramène les
	 * changes du moteur (positions relatives aux frames, re-parentages,
	 * agrandissements) en absolu : frames vers `framesApi`, tables vers le
	 * state `nodes`. */
	readonly handleNodesChange: (changes: NodeChange<TableNodeType>[]) => void;
	/** Persiste la position absolue des tables déplacées depuis le dernier
	 * appel (fin de drag : table, frame et son contenu). */
	readonly persistMovedTables: () => void;
	/** Callback pour `TableNode.onResizeEnd` — persist width/height ET
	 * position au release du NodeResizer (les corners top/left déplacent
	 * l'origine). */
	readonly handleTableResize: (
		name: string,
		size: { width: number; height: number; x: number; y: number }
	) => void;
	/** Agrandit une table pour montrer tous ses champs (« +N champs… »). */
	readonly showAllFields: (name: string) => void;
}

/**
 * Gère le state `nodes` du canvas :
 *   - Seed depuis le layout ELK au mount (lu via ref pour ne pas re-seed à
 *     chaque persistance user → sinon chaque drag-stop clignoterait).
 *   - Overlay des positions + sizes user persistés par-dessus le layout.
 *   - Intercepte les NodeChange pour router les changes sur `frame:*`
 *     vers `framesApi.setFrameRect` (un resize top/left corner émet
 *     `dimensions` ET `position` dans le même batch — on merge par
 *     frame avant d'écrire sinon 2× `setFrameRect` séquentiels perdent
 *     l'un des updates).
 *   - `handleTableResize` : callback stable pour le NodeResizer de chaque
 *     table (persist w/h + x/y + history.push).
 */
export function useCanvasNodes(
	opts: UseCanvasNodesOptions
): UseCanvasNodesReturn {
	const { base, schema, tablePositions, tableSizes, framesApi, history } = opts;
	const [nodes, setNodes, onNodesChange] = useNodesState<TableNodeType>([]);

	// Refs pour les closures — évite la re-création à chaque persistance.
	const tablePositionsRef = useRef(tablePositions.positions);
	tablePositionsRef.current = tablePositions.positions;
	const tableSizesRef = useRef(tableSizes.sizes);
	tableSizesRef.current = tableSizes.sizes;
	const nodesRef = useRef(nodes);
	nodesRef.current = nodes;
	const framesApiRef = useRef(framesApi);
	framesApiRef.current = framesApi;
	// Positions absolues issues des derniers changes, en attente de
	// persistance : le state ne les reflète qu'au rendu suivant.
	const movedRef = useRef(new Map<string, XY>());

	// Seed initial + re-seed au changement de base (nouveau schéma).
	// Lit positions/sizes via ref pour NE PAS re-fire à chaque persistance
	// (drag-stop → tablePositions muté → setNodes(base) clignoterait).
	useEffect(() => {
		if (base !== null) {
			const savedPos = tablePositionsRef.current;
			const savedSize = tableSizesRef.current;
			setNodes(
				base.nodes.map((n) => {
					const pos = savedPos[n.id];
					const size = savedSize[n.id];
					return {
						...n,
						...(pos !== undefined ? { position: pos } : {}),
						...(size?.width !== undefined ? { width: size.width } : {}),
						...(size?.height !== undefined ? { height: size.height } : {})
					};
				})
			);
		}
	}, [base, setNodes]);

	// Le layout est calculé une fois par connexion : un schéma relu (après un
	// changement, ADR-039 D5) redonne à chaque table ses colonnes, et sa
	// hauteur tant qu'elle n'a pas été redimensionnée à la main.
	useEffect(() => {
		setNodes((current) => {
			let changed = false;
			const next = current.map((n) => {
				const collection = schema.collections.find((c) => c.name === n.id);
				if (collection === undefined || collection === n.data.collection) {
					return n;
				}
				changed = true;
				const resized = tableSizesRef.current[n.id]?.height !== undefined;
				return {
					...n,
					ariaLabel: tableAriaLabel(collection),
					data: { ...n.data, collection },
					...(resized ? {} : { height: nodeHeight(collection) })
				};
			});
			return changed ? next : current;
		});
	}, [schema, setNodes]);

	const handleNodesChange = useCallback(
		(changes: NodeChange<TableNodeType>[]) => {
			const api = framesApiRef.current;
			// Les `dimensions` de mesure DOM (sans `resizing` ni
			// `setAttributes`) sont ignorées pour les frames : leur taille
			// vient de `rect`.
			const { frames, tableChanges, moved } = applyCanvasChanges(
				changes,
				api.frames,
				nodesRef.current
			);
			if (frames !== api.frames) api.replaceAll(frames);
			for (const [id, abs] of moved) movedRef.current.set(id, abs);
			if (tableChanges.length > 0) onNodesChange(tableChanges);
		},
		[onNodesChange]
	);

	const persistMovedTables = useCallback(() => {
		const moved = movedRef.current;
		if (moved.size === 0) return;
		tablePositions.setManyPositions(Object.fromEntries(moved));
		movedRef.current = new Map();
	}, [tablePositions]);

	// Callback stable pour le NodeResizer d'une table : persist les nouvelles
	// dimensions ET la nouvelle position au release. La position CHANGE quand
	// le user tire depuis un handle top ou left (l'origine bouge pour
	// garder l'opposé fixe). Sans persister x/y, un refresh remettait la table
	// à l'ancienne origine → elle semblait grossir uniquement vers la droite.
	// `size.x/y` est relatif au frame d'une table imbriquée : la position
	// absolue vient des changes du geste.
	const handleTableResize = useCallback(
		(
			name: string,
			size: { width: number; height: number; x: number; y: number }
		) => {
			tableSizes.setSize(name, { width: size.width, height: size.height });
			const abs =
				movedRef.current.get(name) ??
				nodesRef.current.find((n) => n.id === name)?.position;
			movedRef.current.delete(name);
			if (abs) tablePositions.setPosition(name, abs);
			history.push();
		},
		[tableSizes, tablePositions, history]
	);

	const showAllFields = useCallback(
		(name: string) => {
			const node = nodesRef.current.find((n) => n.id === name);
			if (node === undefined) return;
			const size = {
				width: node.width ?? NODE_WIDTH,
				height: fullNodeHeight(node.data.collection)
			};
			setNodes((current) =>
				current.map((n) => (n.id === name ? { ...n, ...size } : n))
			);
			// Gardée comme un redimensionnement à la main.
			handleTableResize(name, { ...size, ...node.position });
		},
		[setNodes, handleTableResize]
	);

	return {
		nodes,
		setNodes,
		nodesRef,
		handleNodesChange,
		persistMovedTables,
		handleTableResize,
		showAllFields
	};
}
