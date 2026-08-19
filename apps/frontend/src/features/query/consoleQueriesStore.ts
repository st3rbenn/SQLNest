/**
 * Store singleton des queries console SNQL — le state (`isPending`, `data`,
 * `error`, `timingMs`, `lastRunAt`, `lastSource`) vit hors React, indexé
 * par une `queryKey` stable `<connId>[:<scopeSuffix>]:<tabId>`.
 *
 * Motif : `ConsoleShellInner` remount au switch fullscreen ↔ normal (le
 * portal T5 déplace le rendu vers `document.body`), et un `useMutation`
 * local perdrait sa mutation en cours à ce remount → la requête serait
 * abandonnée. Ici le fetch continue en background, le store persiste, le
 * shell qui remount lit à jour le state via `useConsoleQuery(key)`.
 *
 * Pas de TanStack Query pour ce cas précis — `useMutation` n'a pas de
 * mécanisme natif pour partager le state d'une mutation en cours entre
 * plusieurs consumers (contrairement à `useQuery` par queryKey). On reste
 * sur du `useSyncExternalStore` minimal.
 */

import { useSyncExternalStore } from "react";
import {
	type QueryResult,
	type RunQueryInput,
	runQueryRequest,
	SnqlRuntimeError
} from "./useRunQuery";

export interface ConsoleQueryState {
	readonly isPending: boolean;
	readonly data?: QueryResult;
	readonly error: SnqlRuntimeError | null;
	readonly timingMs?: number;
	readonly lastRunAt?: number;
	/** Source SNQL exécutée pour ce state — le shell l'utilise pour ajouter
	 * à l'historique une seule fois par run réussi (via useEffect on
	 * `lastRunAt` change). */
	readonly lastSource?: string;
}

const EMPTY: ConsoleQueryState = { isPending: false, error: null };

const store = new Map<string, ConsoleQueryState>();
const listeners = new Map<string, Set<() => void>>();
const controllers = new Map<string, AbortController>();

function notify(key: string): void {
	const set = listeners.get(key);
	if (!set) return;
	for (const l of set) l();
}

export function getConsoleQueryState(key: string): ConsoleQueryState {
	return store.get(key) ?? EMPTY;
}

function subscribe(key: string, listener: () => void): () => void {
	let set = listeners.get(key);
	if (!set) {
		set = new Set();
		listeners.set(key, set);
	}
	set.add(listener);
	return () => {
		const s = listeners.get(key);
		if (!s) return;
		s.delete(listener);
		if (s.size === 0) listeners.delete(key);
	};
}

/**
 * Lance une requête pour cette `key`. Une run précédente encore pending
 * pour la même key est ignorée (son résultat est jeté au retour du fetch).
 * Le fetch continue même si le shell qui a fire cette fonction unmount —
 * le store est en scope module, indépendant du cycle React.
 */
export async function runConsoleQuery(
	key: string,
	input: RunQueryInput
): Promise<void> {
	controllers.get(key)?.abort();
	const controller = new AbortController();
	controllers.set(key, controller);
	const t0 = performance.now();
	store.set(key, { isPending: true, error: null, lastSource: input.source });
	notify(key);
	try {
		const data = await runQueryRequest(input);
		if (controller.signal.aborted) return;
		const timing = Math.round(performance.now() - t0);
		store.set(key, {
			isPending: false,
			data,
			error: null,
			timingMs: timing,
			lastRunAt: Date.now(),
			lastSource: input.source
		});
		notify(key);
	} catch (e) {
		if (controller.signal.aborted) return;
		const timing = Math.round(performance.now() - t0);
		const err =
			e instanceof SnqlRuntimeError
				? e
				: new SnqlRuntimeError(
						(e as Error | undefined)?.message ?? "Erreur inconnue"
					);
		store.set(key, {
			isPending: false,
			error: err,
			timingMs: timing,
			lastRunAt: Date.now(),
			lastSource: input.source
		});
		notify(key);
	} finally {
		if (controllers.get(key) === controller) controllers.delete(key);
	}
}

/**
 * Hook — s'abonne au state d'une query par clé. Le shell peut monter/
 * remonter librement (portal fullscreen T5), le state reste le même
 * pour la même key.
 */
export function useConsoleQuery(key: string): ConsoleQueryState {
	return useSyncExternalStore(
		(cb) => subscribe(key, cb),
		() => getConsoleQueryState(key)
	);
}
