import { useCallback, useEffect, useMemo, useRef } from "react";
import {
	SYSTEM_TABLE_ID,
	type SystemSchemaEventsNodeType
} from "../../checksum-history/SystemSchemaEventsNode";
import { useSchemaEventsNode } from "../../checksum-history/useSchemaEventsNode";
import {
	ENUMS_NODE_ID,
	type SystemEnumsNodeType
} from "../../enums/SystemEnumsNode";
import { useEnumsNode } from "../../enums/useEnumsNode";
import type { ChangeGesture } from "../editor/changeSnql";
import { canApply, type EditMode } from "../editor/editMode";
import type { Frame } from "../frames";
import type { SchemaModel } from "../schema-model";
import type { TableNodeType } from "../TableNode";
import type { XY } from "../useTablePositions";
import { placeBesideContent, type Rect } from "./systemNodePlacement";

export type SystemNodeType = SystemSchemaEventsNodeType | SystemEnumsNodeType;

export interface UseSystemNodesOptions {
	readonly schema: SchemaModel;
	readonly connectionId: string;
	readonly teamSlug: string;
	readonly editMode: EditMode;
	readonly setGesture: (gesture: ChangeGesture | null) => void;
	/** Ouvre une console remplie : le repli quand l'édition est fermée. */
	readonly openConsoleWithSource: (source: string) => void;
	/** Contenu du canvas : un node système sans place se pose à côté. */
	readonly tableNodes: readonly TableNodeType[];
	readonly frames: readonly Frame[];
	/** Positions du canvas appliquées (état serveur compris) : avant cela,
	 *  le contenu n'est pas encore là où l'utilisateur l'a rangé. */
	readonly ready: boolean;
}

export interface UseSystemNodesReturn {
	/** Nodes système à afficher (un node sans contenu n'y figure pas). */
	readonly nodes: readonly SystemNodeType[];
	/** À appeler avec tous les changes du canvas : chaque node garde les siens. */
	readonly onNodesChange: (changes: never) => void;
	/** Fin de drag : garde la position si `id` est un node système. */
	readonly persistPosition: (id: string, position: XY) => void;
}

/**
 * Nodes système du canvas : événements du schéma et enums. Une entrée par
 * node dans `controls` ; l'affichage, les changes et la persistance du
 * drag itèrent ce tableau. Ajouter un node système = y ajouter une entrée.
 */
export function useSystemNodes({
	schema,
	connectionId,
	teamSlug,
	editMode,
	setGesture,
	openConsoleWithSource,
	tableNodes,
	frames,
	ready
}: UseSystemNodesOptions): UseSystemNodesReturn {
	const systemEvents = useSchemaEventsNode(connectionId, teamSlug);

	// Un enum n'est pas une table : sans ce node il serait invisible. Son
	// « + » ouvre le geste et son aperçu quand l'édition est ouverte, sinon
	// une console remplie de `add enum member <nom> ""`.
	const onAddEnumMember = useCallback(
		(enumName: string) => {
			if (canApply(editMode)) {
				setGesture({ kind: "add-enum-member", enumName });
			} else {
				openConsoleWithSource(`add enum member ${enumName} ""`);
			}
		},
		[openConsoleWithSource, editMode, setGesture]
	);
	const enumEntries = useMemo(
		() =>
			(schema.enums ?? []).map((e) => ({
				name: e.name,
				members: e.members
			})),
		[schema.enums]
	);
	const enumsSystem = useEnumsNode(connectionId, enumEntries, onAddEnumMember);

	const controls = useMemo(
		() =>
			[
				{
					id: SYSTEM_TABLE_ID,
					node: systemEvents.node as SystemNodeType | null,
					onNodesChange: systemEvents.onNodesChange as (changes: never) => void,
					updatePosition: systemEvents.updatePosition,
					hasStoredGeom: systemEvents.hasStoredGeom
				},
				{
					id: ENUMS_NODE_ID,
					node: enumsSystem.node as SystemNodeType | null,
					onNodesChange: enumsSystem.onNodesChange as (changes: never) => void,
					updatePosition: enumsSystem.updatePosition,
					hasStoredGeom: enumsSystem.hasStoredGeom
				}
			] as const,
		[
			systemEvents.node,
			systemEvents.onNodesChange,
			systemEvents.updatePosition,
			systemEvents.hasStoredGeom,
			enumsSystem.node,
			enumsSystem.onNodesChange,
			enumsSystem.updatePosition,
			enumsSystem.hasStoredGeom
		]
	);

	// Un node système qui apparaît pour la première fois sur cette connexion
	// se pose à côté du contenu du canvas, pas à un point fixe où une table
	// peut déjà se trouver. Sa place est ensuite gardée comme après un drag.
	const contentRef = useRef<readonly Rect[]>([]);
	contentRef.current = [
		...tableNodes.map((n) => ({
			x: n.position.x,
			y: n.position.y,
			width: n.width ?? 0,
			height: n.height ?? 0
		})),
		...frames.flatMap((f) => (f.rect !== undefined ? [f.rect] : []))
	];
	const hasContent = ready && tableNodes.length > 0;
	const present = controls.map((c) => (c.node !== null ? c.id : "")).join("|");
	// biome-ignore lint/correctness/useExhaustiveDependencies: `present` résume les nodes affichés ; le contenu se lit par ref, à l'instant du placement
	useEffect(() => {
		if (!hasContent) return;
		const taken: Rect[] = [];
		for (const c of controls) {
			if (c.node === null) continue;
			const size = { width: c.node.width ?? 0, height: c.node.height ?? 0 };
			if (c.hasStoredGeom()) {
				taken.push({ ...c.node.position, ...size });
				continue;
			}
			const spot = placeBesideContent(contentRef.current, taken, size);
			if (spot === null) continue;
			c.updatePosition(spot);
			taken.push({ ...spot, ...size });
		}
	}, [hasContent, present]);

	const nodes = useMemo(
		() => controls.flatMap((c) => (c.node !== null ? [c.node] : [])),
		[controls]
	);
	const onNodesChange = useCallback(
		(changes: never) => {
			for (const c of controls) c.onNodesChange(changes);
		},
		[controls]
	);
	const persistPosition = useCallback(
		(id: string, position: XY) => {
			controls.find((c) => c.id === id)?.updatePosition(position);
		},
		[controls]
	);

	return { nodes, onNodesChange, persistPosition };
}
