import { useEffect, useMemo, useState } from "react";
import {
	type ConsoleTabLastResult,
	consoleTabsKey
} from "../../query/useConsoleTabs";
import { readJson } from "../../storage/localStore";
import { queryTables } from "./queryTables";

/** Une console rattachée à une table par la requête de son onglet actif. */
export interface ConsoleEntry {
	readonly id: string;
	/** Onglet actif : c'est sa requête qui rattache la console. */
	readonly tabId: string;
	readonly source: string;
	readonly title: string;
	readonly root: string;
	readonly joined: readonly string[];
	readonly lastResult?: ConsoleTabLastResult;
}

const UNTITLED = "Sans titre";

function lastResultOf(raw: unknown): ConsoleTabLastResult | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const { rowCount, timingMs } = raw as Record<string, unknown>;
	return typeof rowCount === "number" && typeof timingMs === "number"
		? { rowCount, timingMs }
		: undefined;
}

function readEntry(
	connectionId: string,
	id: string,
	tables: ReadonlySet<string>
): ConsoleEntry | null {
	const raw = readJson(consoleTabsKey(connectionId, id));
	if (typeof raw !== "object" || raw === null) return null;
	const { tabs, activeTabId } = raw as Record<string, unknown>;
	if (!Array.isArray(tabs)) return null;
	const list = tabs as Record<string, unknown>[];
	const tab = list.find((t) => t.id === activeTabId) ?? list[0];
	if (
		tab === undefined ||
		typeof tab.source !== "string" ||
		typeof tab.id !== "string"
	) {
		return null;
	}
	const { root, joined } = queryTables(tab.source);
	if (root === null || !tables.has(root)) return null;
	const firstLine =
		tab.source
			.split("\n")
			.map((l) => l.trim())
			.find((l) => l !== "") ?? root;
	const named = typeof tab.name === "string" && tab.name !== UNTITLED;
	const lastResult = lastResultOf(tab.lastResult);
	return {
		id,
		tabId: tab.id,
		source: tab.source,
		title: named ? (tab.name as string) : firstLine,
		root,
		joined: joined.filter((t) => tables.has(t)),
		...(lastResult !== undefined ? { lastResult } : {})
	};
}

export interface ConsoleIndex {
	readonly entries: readonly ConsoleEntry[];
	/** Vrai quand `entries` a été lu pour les consoles demandées. Faux au
	 * premier rendu, et le temps d'un rendu quand la liste des consoles
	 * change : une console absente de `entries` n'est alors pas encore
	 * « non rattachée », elle n'a simplement pas été lue. */
	readonly ready: boolean;
}

interface IndexState {
	readonly entries: readonly ConsoleEntry[];
	/** Consoles pour lesquelles `entries` a été lu ; `null` : rien de lu. */
	readonly readFor: string | null;
}

const UNREAD: IndexState = { entries: [], readFor: null };

/**
 * Consoles du canvas rattachées à une table. Les onglets vivent dans le
 * stockage local, écrits par chaque console : l'index se relit à chacune de
 * leurs écritures.
 */
export function useConsoleIndex(
	connectionId: string,
	consoleIds: readonly string[],
	tables: ReadonlySet<string>
): ConsoleIndex {
	const [index, setIndex] = useState<IndexState>(UNREAD);
	const idsKey = consoleIds.join(",");
	const scope = `${connectionId}|${idsKey}`;
	useEffect(() => {
		const ids = idsKey === "" ? [] : idsKey.split(",");
		const readFor = `${connectionId}|${idsKey}`;
		const refresh = (): void => {
			const next = ids.flatMap((id) => {
				const entry = readEntry(connectionId, id, tables);
				return entry === null ? [] : [entry];
			});
			setIndex((prev) =>
				prev.readFor === readFor &&
				JSON.stringify(prev.entries) === JSON.stringify(next)
					? prev
					: { entries: next, readFor }
			);
		};
		refresh();
		window.addEventListener("mantine-local-storage", refresh);
		window.addEventListener("storage", refresh);
		return () => {
			window.removeEventListener("mantine-local-storage", refresh);
			window.removeEventListener("storage", refresh);
		};
	}, [connectionId, idsKey, tables]);
	return useMemo(
		() => ({ entries: index.entries, ready: index.readFor === scope }),
		[index, scope]
	);
}
