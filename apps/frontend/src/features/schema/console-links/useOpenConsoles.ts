import { useCallback, useEffect, useState } from "react";
import {
	connectionKey,
	readJson,
	removeKey,
	writeJson
} from "../../storage/localStore";

type Ids = readonly string[];

/** Consoles qui ont encore un frame gardé pour cette connexion. */
function existing(connectionId: string): ReadonlySet<unknown> {
	const frames = readJson(connectionKey("console-nodes", connectionId));
	return new Set(
		Array.isArray(frames)
			? frames.map((f: unknown) => (f as { id?: unknown } | null)?.id)
			: []
	);
}

/** Une console supprimée depuis ne revient pas parmi les dépliées. */
function load(connectionId: string): Ids {
	const parsed = readJson(connectionKey("console-open", connectionId));
	if (!Array.isArray(parsed)) return [];
	const alive = existing(connectionId);
	return parsed.filter(
		(id): id is string => typeof id === "string" && alive.has(id)
	);
}

interface OpenState {
	readonly connectionId: string;
	readonly ids: Ids;
}

/**
 * Consoles dépliées d'une connexion, la plus récente en dernier. Gardées
 * dans le stockage local : un canvas rechargé retrouve dépliées celles qui
 * l'étaient.
 */
export function useOpenConsoles(
	connectionId: string
): readonly [Ids, (update: (ids: Ids) => Ids) => void] {
	const [state, setState] = useState<OpenState>(() => ({
		connectionId,
		ids: load(connectionId)
	}));
	// Changer de connexion sans démonter le canvas : ses consoles à elle.
	const current =
		state.connectionId === connectionId
			? state
			: { connectionId, ids: load(connectionId) };
	if (current !== state) setState(current);

	useEffect(() => {
		const key = connectionKey("console-open", current.connectionId);
		if (current.ids.length === 0) removeKey(key);
		else writeJson(key, current.ids);
	}, [current]);

	const update = useCallback((next: (ids: Ids) => Ids) => {
		setState((prev) => {
			const ids = next(prev.ids);
			return ids === prev.ids ? prev : { ...prev, ids };
		});
	}, []);
	return [current.ids, update];
}
