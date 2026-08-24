import { useCallback, useEffect, useMemo, useState } from "react";
import {
	SYSTEM_TABLE_ID,
	type SystemSchemaEventsNodeType
} from "./SystemSchemaEventsNode";

/**
 * Position persistée du node système `schema_events` — un par connection.
 * localStorage suffit v1 : la position n'a pas besoin d'être synchronisée
 * cross-device (chaque device peut placer ce meta-node où il veut sans
 * casser la sémantique de la table).
 */
const STORAGE_PREFIX = "sqlnest:systemNode:schemaEvents:";
const DEFAULT_POSITION = { x: 40, y: 40 };

function storageKey(connectionId: string): string {
	return `${STORAGE_PREFIX}${connectionId}`;
}

function readPosition(connectionId: string): { x: number; y: number } {
	if (typeof window === "undefined") return DEFAULT_POSITION;
	try {
		const raw = window.localStorage.getItem(storageKey(connectionId));
		if (raw === null) return DEFAULT_POSITION;
		const parsed = JSON.parse(raw) as unknown;
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			typeof (parsed as { x?: unknown }).x === "number" &&
			typeof (parsed as { y?: unknown }).y === "number"
		) {
			return { x: (parsed as { x: number }).x, y: (parsed as { y: number }).y };
		}
	} catch {
		/* JSON malformé — retombe sur le défaut */
	}
	return DEFAULT_POSITION;
}

function writePosition(
	connectionId: string,
	position: { x: number; y: number }
): void {
	if (typeof window === "undefined") return;
	try {
		window.localStorage.setItem(
			storageKey(connectionId),
			JSON.stringify(position)
		);
	} catch {
		/* quota / private mode — perte de position acceptable */
	}
}

/**
 * Fabrique le node RF système et son handler `onDragStop` qui persist la
 * position localStorage. Le node est **non-supprimable** (`deletable: false`)
 * et **non-sélectionnable** en lasso (`selectable: false`) — reste focussable
 * au clic simple.
 */
export function useSchemaEventsNode(
	connectionId: string,
	teamSlug: string
): {
	readonly node: SystemSchemaEventsNodeType;
	readonly onPositionChange: (position: {
		x: number;
		y: number;
	}) => void;
} {
	const [position, setPosition] = useState(() => readPosition(connectionId));

	useEffect(() => {
		setPosition(readPosition(connectionId));
	}, [connectionId]);

	const onPositionChange = useCallback(
		(next: { x: number; y: number }) => {
			setPosition(next);
			writePosition(connectionId, next);
		},
		[connectionId]
	);

	const node = useMemo<SystemSchemaEventsNodeType>(
		() => ({
			id: SYSTEM_TABLE_ID,
			type: "system-schema-events",
			position,
			data: { connectionId, teamSlug },
			// Non-supprimable : Backspace natif RF ne le retire pas.
			deletable: false,
			// Non-lassoable : la sélection multi ne l'inclut pas.
			selectable: false,
			// Draggable OK — l'user le déplace, position persistée à onDragStop.
			draggable: true
		}),
		[position, connectionId, teamSlug]
	);

	return { node, onPositionChange };
}
