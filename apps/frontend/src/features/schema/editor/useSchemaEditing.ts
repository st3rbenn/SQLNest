import type { Connection } from "@sqlnest/canvas";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { SchemaModel } from "../schema-model";
import { fieldOfHandle } from "../TableNode";
import type { ChangeGesture } from "./changeSnql";
import { type EditMode, editModeOf } from "./editMode";
import { useProjectStatus } from "./useProjectStatus";

export interface UseSchemaEditingOptions {
	readonly schema: SchemaModel;
	readonly teamSlug: string;
	readonly connectionId: string;
}

export interface UseSchemaEditingReturn {
	/** Mode déduit du projet relié et de la base (ADR-039 D1). */
	readonly editMode: EditMode;
	/** Geste ouvert dans le panneau de droite. */
	readonly gesture: ChangeGesture | null;
	readonly setGesture: (gesture: ChangeGesture | null) => void;
	readonly inferencePanelOpen: boolean;
	readonly setInferencePanelOpen: React.Dispatch<React.SetStateAction<boolean>>;
	/** Tracé relâché sur un champ : la relation part du champ de départ. */
	readonly traceRelation: (connection: Connection) => void;
}

/**
 * Changement de schéma depuis le canvas (ADR-039). Un seul panneau à
 * droite : ouvrir un geste ferme le panneau des liens inférés, et l'inverse.
 */
export function useSchemaEditing({
	schema,
	teamSlug,
	connectionId
}: UseSchemaEditingOptions): UseSchemaEditingReturn {
	const projectStatus = useProjectStatus(teamSlug, connectionId);
	const editMode = useMemo(
		() =>
			editModeOf(
				schema,
				projectStatus.data !== undefined
					? { data: projectStatus.data }
					: projectStatus.error !== null
						? { error: projectStatus.error.message }
						: undefined
			),
		[schema, projectStatus.data, projectStatus.error]
	);

	const [inferencePanelOpen, setInferencePanelOpen] = useState(false);
	const [gesture, setGestureState] = useState<ChangeGesture | null>(null);
	const setGesture = useCallback((next: ChangeGesture | null) => {
		setGestureState(next);
		if (next !== null) setInferencePanelOpen(false);
	}, []);
	useEffect(() => {
		if (inferencePanelOpen) setGestureState(null);
	}, [inferencePanelOpen]);

	const traceRelation = useCallback(
		(c: Connection) => {
			const column = fieldOfHandle(c.sourceHandle);
			const targetColumn = fieldOfHandle(c.targetHandle);
			if (column === undefined || targetColumn === undefined) return;
			if (c.source === c.target && column === targetColumn) return;
			setGesture({
				kind: "add-ref",
				table: c.source,
				column,
				targetTable: c.target,
				targetColumn
			});
		},
		[setGesture]
	);

	return {
		editMode,
		gesture,
		setGesture,
		inferencePanelOpen,
		setInferencePanelOpen,
		traceRelation
	};
}
