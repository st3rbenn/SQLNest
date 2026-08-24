import { useNodesState } from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef } from "react";
import {
	SYSTEM_TABLE_DEFAULT_HEIGHT,
	SYSTEM_TABLE_DEFAULT_WIDTH,
	SYSTEM_TABLE_ID,
	type SystemSchemaEventsNodeType
} from "./SystemSchemaEventsNode";

/**
 * Géométrie persistée du node système — un par connection. localStorage
 * suffit v1 : la position n'a pas besoin d'être synchronisée cross-device.
 */
interface SystemGeom {
	readonly position: { readonly x: number; readonly y: number };
	readonly width: number;
	readonly height: number;
}

const STORAGE_PREFIX = "sqlnest:systemNode:schemaEvents:";
const DEFAULT_GEOM: SystemGeom = {
	position: { x: 40, y: 40 },
	width: SYSTEM_TABLE_DEFAULT_WIDTH,
	height: SYSTEM_TABLE_DEFAULT_HEIGHT
};

function storageKey(connectionId: string): string {
	return `${STORAGE_PREFIX}${connectionId}`;
}

function loadGeom(connectionId: string): SystemGeom {
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
			const p = parsed as SystemGeom;
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

function saveGeom(connectionId: string, geom: SystemGeom): void {
	if (typeof window === "undefined") return;
	try {
		window.localStorage.setItem(storageKey(connectionId), JSON.stringify(geom));
	} catch {
		/* quota / private mode — perte de position acceptable */
	}
}

/**
 * State RF du node système `schema_events` — un seul node dans le tableau
 * `nodes`, mais on suit le pattern `useNodesState` (comme `useConsoleNodes`)
 * pour que RF pilote nativement le drag / resize. Le state est composé
 * avec `handleNodesChange` global du canvas via `onNodesChange`.
 *
 * Persist localStorage à `onNodeDragStop` (position finale) et
 * `NodeResizer.onResizeEnd` (dimensions finales) — jamais pendant le geste.
 */
export function useSchemaEventsNode(
	connectionId: string,
	teamSlug: string
): {
	readonly node: SystemSchemaEventsNodeType;
	readonly onNodesChange: (
		changes: Parameters<
			ReturnType<typeof useNodesState<SystemSchemaEventsNodeType>>[2]
		>[0]
	) => void;
	readonly updatePosition: (
		position: { x: number; y: number }
	) => void;
	readonly updateGeom: (geom: {
		position: { x: number; y: number };
		width: number;
		height: number;
	}) => void;
} {
	const initial = useMemo<SystemSchemaEventsNodeType[]>(
		() => {
			const geom = loadGeom(connectionId);
			return [
				{
					id: SYSTEM_TABLE_ID,
					type: "system-schema-events",
					position: geom.position,
					width: geom.width,
					height: geom.height,
					data: { connectionId, teamSlug },
					deletable: false,
					selectable: false,
					draggable: true
				}
			];
		},
		[connectionId, teamSlug]
	);

	const [nodes, setNodes, onNodesChange] =
		useNodesState<SystemSchemaEventsNodeType>(initial);

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
				prev.map((n) =>
					n.id === SYSTEM_TABLE_ID ? { ...n, position } : n
				)
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
					n.id === SYSTEM_TABLE_ID
						? { ...n, position: g.position, width: g.width, height: g.height }
						: n
				)
			);
			saveGeom(connectionId, g);
		},
		[connectionId, setNodes]
	);

	// Inject `onResizeEnd` dans data pour que le NodeResizer du node puisse
	// appeler updateGeom au release — RF déplace l'origine sur un drag depuis
	// un handle top/left, il faut donc persister x/y avec width/height.
	const node = useMemo<SystemSchemaEventsNodeType>(() => {
		const base = nodes[0] as SystemSchemaEventsNodeType;
		return {
			...base,
			data: {
				...base.data,
				onResizeEnd: (params) =>
					updateGeom({
						position: { x: params.x, y: params.y },
						width: params.width,
						height: params.height
					})
			}
		};
	}, [nodes, updateGeom]);

	return { node, onNodesChange, updatePosition, updateGeom };
}
