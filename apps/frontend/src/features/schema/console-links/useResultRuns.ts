import { useCallback, useMemo, useSyncExternalStore } from "react";
import {
	type ConsoleQueryState,
	getConsoleQueryState,
	subscribeConsoleQuery
} from "../../query/consoleQueriesStore";
import type { ConsoleEntry } from "./useConsoleIndex";

/** Clé du store de requêtes pour l'onglet actif d'une console du canvas. */
export function resultKey(connectionId: string, entry: ConsoleEntry): string {
	return `${connectionId}:${entry.id}:${entry.tabId}`;
}

/**
 * Ce que `pick` retient de l'état de requête de chaque console, par
 * console ; `null` : rien à retenir. `pick` est une fonction de module :
 * le canvas ne se redessine que lorsqu'une de ces valeurs change.
 */
function useQueryStates(
	connectionId: string,
	entries: readonly ConsoleEntry[],
	pick: (state: ConsoleQueryState) => string | null
): ReadonlyMap<string, string> {
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
				const value = pick(getConsoleQueryState(key));
				return value === null ? [] : [`${id}@${value}`];
			})
			.join("|")
	);
	return useMemo(() => {
		const values = new Map<string, string>();
		if (snapshot === "") return values;
		for (const part of snapshot.split("|")) {
			const at = part.lastIndexOf("@");
			values.set(part.slice(0, at), part.slice(at + 1));
		}
		return values;
	}, [snapshot]);
}

const runAt = (state: ConsoleQueryState): string | null =>
	state.data !== undefined &&
	state.data.columns.length > 0 &&
	state.lastRunAt !== undefined
		? String(state.lastRunAt)
		: null;

/**
 * Consoles qui ont des lignes à montrer, avec l'instant de leur dernière
 * exécution. Une écriture sans colonnes n'en fait pas partie : son statut
 * reste dans la console.
 */
export function useResultRuns(
	connectionId: string,
	entries: readonly ConsoleEntry[]
): ReadonlyMap<string, number> {
	const states = useQueryStates(connectionId, entries, runAt);
	return useMemo(
		() => new Map([...states].map(([id, at]) => [id, Number(at)])),
		[states]
	);
}

/** Ce qu'une console repliée doit encore dire de sa requête. */
export type ConsoleRunStatus = "running" | "error";

const runStatus = (state: ConsoleQueryState): ConsoleRunStatus | null =>
	state.isPending ? "running" : state.error !== null ? "error" : null;

/** Consoles dont la requête tourne ou a échoué. */
export function useRunStatuses(
	connectionId: string,
	entries: readonly ConsoleEntry[]
): ReadonlyMap<string, ConsoleRunStatus> {
	return useQueryStates(connectionId, entries, runStatus) as ReadonlyMap<
		string,
		ConsoleRunStatus
	>;
}
