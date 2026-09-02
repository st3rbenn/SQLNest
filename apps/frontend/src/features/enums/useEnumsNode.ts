import { useNodesState } from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef } from "react";
import {
	ENUMS_NODE_DEFAULT_HEIGHT,
	ENUMS_NODE_DEFAULT_WIDTH,
	ENUMS_NODE_ID,
	type EnumNodeEntry,
	type SystemEnumsNodeType
} from "./SystemEnumsNode";

/**
 * Géométrie persistée du node système Enums — un par connection.
 * localStorage suffit (miroir `useSchemaEventsNode` : la position n'a pas
 * besoin d'être synchronisée cross-device).
 */
interface EnumsGeom {
	readonly position: { readonly x: number; readonly y: number };
	readonly width: number;
	readonly height: number;
}

const STORAGE_PREFIX = "sqlnest:systemNode:enums:";
const DEFAULT_GEOM: EnumsGeom = {
	// Décalé sous le node schema_events (40,40) pour ne pas se superposer
	// au premier rendu — l'user replace ensuite, position persistée.
	position: { x: 40, y: 270 },
	width: ENUMS_NODE_DEFAULT_WIDTH,
	height: ENUMS_NODE_DEFAULT_HEIGHT
};

function storageKey(connectionId: string): string {
	return `${STORAGE_PREFIX}${connectionId}`;
}

function loadGeom(connectionId: string): EnumsGeom {
	if (typeof window === "undefined") return DEFAULT_GEOM;
	try {
		const raw = window.localStorage.getItem(storageKey(connectionId));
		if (raw === null) return DEFAULT_GEOM;
		const parsed = JSON.parse(raw) as unknown;
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			typeof (parsed as { position?: unknown }).position === "object" &&
			typeof (parsed as { width?: unknown }).width === "number" &&
			typeof (parsed as { height?: unknown }).height === "number"
		) {
			const p = parsed as EnumsGeom;
			if (
				typeof p.position?.x === "number" &&
				typeof p.position?.y === "number"
			) {
				return p;
			}
		}
	} catch {
		/* JSON malformé — retombe sur le défaut */
	}
	return DEFAULT_GEOM;
}

function saveGeom(connectionId: string, geom: EnumsGeom): void {
	if (typeof window === "undefined") return;
	try {
		window.localStorage.setItem(storageKey(connectionId), JSON.stringify(geom));
	} catch {
		/* quota / private mode — perte de position acceptable */
	}
}

/**
 * State RF du node système « Enums » — miroir strict de `useSchemaEventsNode`
 * (useNodesState pour que RF pilote drag/resize, persist au drop/release).
 * `node` est `null` quand le schéma ne déclare aucun enum : le node n'est
 * pas injecté (un panneau vide serait du bruit).
 */
export function useEnumsNode(
	connectionId: string,
	enums: readonly EnumNodeEntry[],
	onAddMember: (enumName: string) => void
): {
	readonly node: SystemEnumsNodeType | null;
	readonly onNodesChange: (
		changes: Parameters<
			ReturnType<typeof useNodesState<SystemEnumsNodeType>>[2]
		>[0]
	) => void;
	readonly updatePosition: (position: { x: number; y: number }) => void;
} {
	const initial = useMemo<SystemEnumsNodeType[]>(() => {
		const geom = loadGeom(connectionId);
		return [
			{
				id: ENUMS_NODE_ID,
				type: "system-enums",
				position: geom.position,
				width: geom.width,
				height: geom.height,
				data: { enums: [] },
				deletable: false,
				selectable: false,
				draggable: true
			}
		];
	}, [connectionId]);

	const [nodes, setNodes, onNodesChange] =
		useNodesState<SystemEnumsNodeType>(initial);

	// Reset le state RF quand connectionId change — évite de trainer la
	// géométrie de la connexion précédente sur un autre canvas.
	const lastConnRef = useRef(connectionId);
	useEffect(() => {
		if (lastConnRef.current !== connectionId) {
			lastConnRef.current = connectionId;
			setNodes(initial);
		}
	}, [connectionId, initial, setNodes]);

	const updatePosition = useCallback(
		(position: { x: number; y: number }): void => {
			setNodes((prev) =>
				prev.map((n) => (n.id === ENUMS_NODE_ID ? { ...n, position } : n))
			);
			const geom = loadGeom(connectionId);
			saveGeom(connectionId, { ...geom, position });
		},
		[connectionId, setNodes]
	);

	const updateGeom = useCallback(
		(g: {
			position: { x: number; y: number };
			width: number;
			height: number;
		}): void => {
			setNodes((prev) =>
				prev.map((n) =>
					n.id === ENUMS_NODE_ID
						? { ...n, position: g.position, width: g.width, height: g.height }
						: n
				)
			);
			saveGeom(connectionId, g);
		},
		[connectionId, setNodes]
	);

	// data recomposée à chaque render : les enums viennent du schéma (live,
	// re-fetch post-DDL) et les callbacks doivent voir le state courant.
	const node = useMemo<SystemEnumsNodeType | null>(() => {
		if (enums.length === 0) return null;
		const base = nodes[0] as SystemEnumsNodeType;
		return {
			...base,
			data: {
				enums,
				onAddMember,
				onResizeEnd: (params) =>
					updateGeom({
						position: { x: params.x, y: params.y },
						width: params.width,
						height: params.height
					})
			}
		};
	}, [nodes, enums, onAddMember, updateGeom]);

	return { node, onNodesChange, updatePosition };
}
