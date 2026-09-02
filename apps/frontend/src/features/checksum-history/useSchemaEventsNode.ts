import { useMemo } from "react";
import {
	type SystemNodeGeom,
	useSystemNodeGeom
} from "../schema/nodes/useSystemNodeGeom";
import {
	SYSTEM_TABLE_DEFAULT_HEIGHT,
	SYSTEM_TABLE_DEFAULT_WIDTH,
	SYSTEM_TABLE_ID,
	type SystemSchemaEventsNodeType
} from "./SystemSchemaEventsNode";

// Préfixe historique conservé tel quel — les positions déjà persistées des
// users ne doivent pas être perdues par le refactor vers useSystemNodeGeom.
const STORAGE_PREFIX = "sqlnest:systemNode:schemaEvents:";
const DEFAULT_GEOM: SystemNodeGeom = {
	position: { x: 40, y: 40 },
	width: SYSTEM_TABLE_DEFAULT_WIDTH,
	height: SYSTEM_TABLE_DEFAULT_HEIGHT
};

/**
 * State RF du node système `schema_events`. La persistence géométrie + le
 * state RF vivent dans le générique [[useSystemNodeGeom]] (partagé avec le
 * node Enums) — ici uniquement la composition de `data` (connectionId,
 * teamSlug, onResizeEnd branché sur updateGeom).
 */
export function useSchemaEventsNode(
	connectionId: string,
	teamSlug: string
): {
	readonly node: SystemSchemaEventsNodeType;
	readonly onNodesChange: ReturnType<
		typeof useSystemNodeGeom<SystemSchemaEventsNodeType>
	>["onNodesChange"];
	readonly updatePosition: (position: { x: number; y: number }) => void;
	readonly updateGeom: (geom: SystemNodeGeom) => void;
} {
	const geomApi = useSystemNodeGeom<SystemSchemaEventsNodeType>(
		connectionId,
		STORAGE_PREFIX,
		DEFAULT_GEOM,
		(geom) => ({
			id: SYSTEM_TABLE_ID,
			type: "system-schema-events",
			position: geom.position,
			width: geom.width,
			height: geom.height,
			data: { connectionId, teamSlug },
			deletable: false,
			selectable: false,
			draggable: true
		})
	);

	// data recomposée à chaque render — `onResizeEnd` doit voir l'updateGeom
	// courant (RF déplace l'origine sur un handle top/left, il faut persister
	// x/y avec width/height).
	const node = useMemo<SystemSchemaEventsNodeType>(
		() => ({
			...geomApi.node,
			data: {
				connectionId,
				teamSlug,
				onResizeEnd: (params) =>
					geomApi.updateGeom({
						position: { x: params.x, y: params.y },
						width: params.width,
						height: params.height
					})
			}
		}),
		[geomApi.node, geomApi.updateGeom, connectionId, teamSlug]
	);

	return {
		node,
		onNodesChange: geomApi.onNodesChange,
		updatePosition: geomApi.updatePosition,
		updateGeom: geomApi.updateGeom
	};
}
