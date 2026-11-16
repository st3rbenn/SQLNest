import { useCallback, useMemo, useSyncExternalStore } from "react";
import {
	getConsoleQueryState,
	subscribeConsoleQuery
} from "../../query/consoleQueriesStore";
import type { ConsoleEntry } from "./useConsoleIndex";

/** Clé du store de requêtes pour l'onglet actif d'une console du canvas. */
export function resultKey(connectionId: string, entry: ConsoleEntry): string {
	return `${connectionId}:${entry.id}:${entry.tabId}`;
}

/**
 * Consoles qui ont des lignes à montrer, avec l'instant de leur dernière
 * exécution. Une écriture sans colonnes n'en fait pas partie : son statut
 * reste dans la console.
 */
export function useResultRuns(
	connectionId: string,
	entries: readonly ConsoleEntry[]
): ReadonlyMap<string, number> {
	const keyed = useMemo(
		() => entries.map((e) => ({ id: e.id, key: resultKey(connectionId, e) })),
		[connectionId, entries]
	);
	const subscribe = useCallback(
		(onChange: () => void) => {
			const offs = keyed.map((k) => subscribeConsoleQuery(k.key, onChange));
			return () => {
				for (const off of offs) off();
			};
		},
		[keyed]
	);
	// Une chaîne : le snapshot doit rester identique tant que rien ne change.
	const snapshot = useSyncExternalStore(subscribe, () =>
		keyed
			.flatMap(({ id, key }) => {
				const state = getConsoleQueryState(key);
				return state.data !== undefined &&
					state.data.columns.length > 0 &&
					state.lastRunAt !== undefined
					? [`${id}@${state.lastRunAt}`]
					: [];
			})
			.join("|")
	);
	return useMemo(() => {
		const runs = new Map<string, number>();
		if (snapshot === "") return runs;
		for (const part of snapshot.split("|")) {
			const at = part.lastIndexOf("@");
			runs.set(part.slice(0, at), Number(part.slice(at + 1)));
		}
		return runs;
	}, [snapshot]);
}
