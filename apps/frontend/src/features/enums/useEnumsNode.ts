import { useMemo } from "react";
import {
	type SystemNodeGeom,
	useSystemNodeGeom
} from "../schema/nodes/useSystemNodeGeom";
import {
	ENUMS_NODE_DEFAULT_HEIGHT,
	ENUMS_NODE_DEFAULT_WIDTH,
	ENUMS_NODE_ID,
	type EnumNodeEntry,
	type SystemEnumsNodeType
} from "./SystemEnumsNode";

const STORAGE_PREFIX = "sqlnest:systemNode:enums:";
const DEFAULT_GEOM: SystemNodeGeom = {
	// Décalé sous le node schema_events (40,40) pour ne pas se superposer
	// au premier rendu — l'user replace ensuite, position persistée.
	position: { x: 40, y: 270 },
	width: ENUMS_NODE_DEFAULT_WIDTH,
	height: ENUMS_NODE_DEFAULT_HEIGHT
};

/**
 * State RF du node système « Enums ». La persistence géométrie + le state
 * RF vivent dans le générique [[useSystemNodeGeom]] (partagé avec
 * schema_events) — ici uniquement la composition de `data` (enums live du
 * schéma, onAddMember, onResizeEnd). `node` est `null` quand le schéma ne
 * déclare aucun enum : le node n'est pas injecté (un panneau vide serait
 * du bruit).
 */
export function useEnumsNode(
	connectionId: string,
	enums: readonly EnumNodeEntry[],
	onAddMember: (enumName: string) => void
): {
	readonly node: SystemEnumsNodeType | null;
	readonly onNodesChange: ReturnType<
		typeof useSystemNodeGeom<SystemEnumsNodeType>
	>["onNodesChange"];
	readonly updatePosition: (position: { x: number; y: number }) => void;
} {
	const geomApi = useSystemNodeGeom<SystemEnumsNodeType>(
		connectionId,
		STORAGE_PREFIX,
		DEFAULT_GEOM,
		(geom) => ({
			id: ENUMS_NODE_ID,
			type: "system-enums",
			position: geom.position,
			width: geom.width,
			height: geom.height,
			data: { enums: [] },
			deletable: false,
			selectable: false,
			draggable: true
		})
	);

	// data recomposée à chaque render : les enums viennent du schéma (live,
	// re-fetch post-DDL) et les callbacks doivent voir le state courant.
	const node = useMemo<SystemEnumsNodeType | null>(() => {
		if (enums.length === 0) return null;
		return {
			...geomApi.node,
			data: {
				enums,
				onAddMember,
				onResizeEnd: (params) =>
					geomApi.updateGeom({
						position: { x: params.x, y: params.y },
						width: params.width,
						height: params.height
					})
			}
		};
	}, [geomApi.node, geomApi.updateGeom, enums, onAddMember]);

	return {
		node,
		onNodesChange: geomApi.onNodesChange,
		updatePosition: geomApi.updatePosition
	};
}
