import { type NodeChange, useNodesState } from "@xyflow/react";
import { useCallback, useEffect, useRef } from "react";
import type { LayoutResult } from "../layout";
import type { TableNodeType } from "../TableNode";
import type { FramesApi } from "../useFrames";
import type { PositionsApi } from "../useTablePositions";
import type { SizesApi } from "../useTableSizes";

export interface UseCanvasNodesOptions {
	readonly base: LayoutResult | null;
	readonly tablePositions: PositionsApi;
	readonly tableSizes: SizesApi;
	readonly framesApi: FramesApi;
	readonly history: { readonly push: () => void };
}

export interface UseCanvasNodesReturn {
	/** State React Flow — filtré + décoré par le parent avant d'être passé
	 * à `<ReactFlow>`. */
	readonly nodes: TableNodeType[];
	/** Setter direct — exposé car `useCanvasSync.replaceAll.{positions,sizes}`
	 * et `useCanvasSelection` en ont besoin pour repush le state RF à
	 * l'hydratation server ou au multi-select. */
	readonly setNodes: React.Dispatch<React.SetStateAction<TableNodeType[]>>;
	/** Version RAF de nodes — pour les closures qui ont besoin de la dernière
	 * position sans se refermer sur une snapshot obsolète (`handleFrameResize`
	 * qui inspecte les centres des tables membres, `handleSelectionEnd`, …). */
	readonly nodesRef: React.MutableRefObject<TableNodeType[]>;
	/** Handler à passer à `<ReactFlow onNodesChange={...}>`. Wrapper qui
	 * intercepte les NodeChange concernant les frames et route vers
	 * `framesApi.setFrameRect` ; forward le reste à `onNodesChange` natif RF. */
	readonly handleNodesChange: (changes: NodeChange<TableNodeType>[]) => void;
	/** Callback pour `TableNode.onResizeEnd` — persist width/height ET
	 * position au release du NodeResizer (les corners top/left déplacent
	 * l'origine). */
	readonly handleTableResize: (
		name: string,
		size: { width: number; height: number; x: number; y: number }
	) => void;
}

/**
 * Gère le state React Flow `nodes` du canvas :
 *   - Seed depuis le layout ELK au mount (lu via ref pour ne pas re-seed à
 *     chaque persistance user → sinon chaque drag-stop clignoterait).
 *   - Overlay des positions + sizes user persistés par-dessus le layout.
 *   - Intercepte les NodeChange RF pour router les changes sur `frame:*`
 *     vers `framesApi.setFrameRect` (RF émet des `dimensions` ET `position`
 *     dans le même batch pour un resize top/left corner — on merge par
 *     frame avant d'écrire sinon 2× `setFrameRect` séquentiels perdent
 *     l'un des updates).
 *   - `handleTableResize` : callback stable pour le NodeResizer de chaque
 *     table (persist w/h + x/y + history.push).
 */
export function useCanvasNodes(
	opts: UseCanvasNodesOptions
): UseCanvasNodesReturn {
	const { base, tablePositions, tableSizes, framesApi, history } = opts;
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

	const handleNodesChange = useCallback(
		(changes: NodeChange<TableNodeType>[]) => {
			const restChanges: NodeChange<TableNodeType>[] = [];
			const api = framesApiRef.current;
			// RF émet dimensions ET position dans le MÊME batch pour un resize
			// depuis un corner top/left. On doit fusionner par frame avant l'écriture
			// — sinon deux `setFrameRect` séquentiels lisent `frame.rect` frozen
			// avant le premier setState (async), et le 2e écrase le 1er.
			// Bug symptomatique : tire vers la gauche → seule `position.x` s'applique,
			// la nouvelle `width` est perdue → visuellement le frame « pousse à droite ».
			const perFrame = new Map<
				string,
				{ x?: number; y?: number; width?: number; height?: number }
			>();
			for (const c of changes) {
				// NodeChange est une union discriminée : `NodeAddChange` porte
				// l'id sur `c.item.id`, pas `c.id`. On ignore les `add` pour le
				// framing (RF ne crée jamais un frame côté runtime — les frames
				// viennent tous de `framesApi.frames` via `computeFrameNodes`).
				if (c.type === "add") {
					restChanges.push(c);
					continue;
				}
				if (!c.id.startsWith("frame:")) {
					restChanges.push(c);
					continue;
				}
				const key = c.id.slice("frame:".length);
				if (c.type === "dimensions" && c.dimensions) {
					// RF émet AUSSI des `dimensions` en dehors de tout geste (mesure
					// DOM auto). `resizing !== true` = mesure → on ignore, sinon on
					// écrit à chaque render la même dimension et on peut casser le rect.
					if (c.resizing !== true) continue;
					const entry = perFrame.get(key) ?? {};
					entry.width = c.dimensions.width;
					entry.height = c.dimensions.height;
					perFrame.set(key, entry);
				} else if (c.type === "position" && c.position) {
					// `position` sur un frame — deux origines :
					//   1) resize corner top/left → RF émet position (`dragging: false`)
					//   2) drag manuel → `dragging: true`, géré par `onNodeDrag` custom
					//      qui shift les membres. SKIP ici pour éviter la double-update.
					if (c.dragging === true) continue;
					const entry = perFrame.get(key) ?? {};
					entry.x = c.position.x;
					entry.y = c.position.y;
					perFrame.set(key, entry);
				}
				// select/remove/… pour les frames → ignorés (non-selectable).
			}
			for (const [key, entry] of perFrame) {
				const frame = api.frames.find((f) => f.key === key);
				if (!frame?.rect) continue;
				api.setFrameRect(key, {
					x: entry.x ?? frame.rect.x,
					y: entry.y ?? frame.rect.y,
					width: entry.width ?? frame.rect.width,
					height: entry.height ?? frame.rect.height
				});
			}
			if (restChanges.length > 0) onNodesChange(restChanges);
		},
		[onNodesChange]
	);

	// Callback stable pour le NodeResizer d'une table : persist les nouvelles
	// dimensions ET la nouvelle position au release. La position CHANGE quand
	// le user tire depuis un handle top ou left (RF déplace l'origine pour
	// garder l'opposé fixe). Sans persister x/y, un refresh remettait la table
	// à l'ancienne origine → elle semblait grossir uniquement vers la droite.
	const handleTableResize = useCallback(
		(
			name: string,
			size: { width: number; height: number; x: number; y: number }
		) => {
			tableSizes.setSize(name, { width: size.width, height: size.height });
			tablePositions.setPosition(name, { x: size.x, y: size.y });
			history.push();
		},
		[tableSizes, tablePositions, history]
	);

	return {
		nodes,
		setNodes,
		nodesRef,
		handleNodesChange,
		handleTableResize
	};
}
