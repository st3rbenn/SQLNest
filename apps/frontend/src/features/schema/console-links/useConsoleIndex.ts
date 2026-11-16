import { useEffect, useState } from "react";
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
	/** Faux tant que les onglets n'ont pas été lus une première fois : une
	 * console absente de `entries` n'est alors pas encore « non rattachée ». */
	readonly ready: boolean;
}

const EMPTY: ConsoleIndex = { entries: [], ready: false };

/**
 * Consoles du canvas rattachées à une table. Les onglets vivent dans le
 * stockage local, écrits par chaque console : l'index se relit à chacune de
 * leurs écritures.
 */
export function useConsoleIndex(
	enabled: boolean,
	connectionId: string,
	consoleIds: readonly string[],
	tables: ReadonlySet<string>
): ConsoleIndex {
	const [index, setIndex] = useState<ConsoleIndex>(EMPTY);
	const idsKey = consoleIds.join(",");
	useEffect(() => {
		if (!enabled) {
			setIndex(EMPTY);
			return;
		}
		const ids = idsKey === "" ? [] : idsKey.split(",");
		const refresh = (): void => {
			const next = ids.flatMap((id) => {
				const entry = readEntry(connectionId, id, tables);
				return entry === null ? [] : [entry];
			});
			setIndex((prev) =>
				prev.ready && JSON.stringify(prev.entries) === JSON.stringify(next)
					? prev
					: { entries: next, ready: true }
			);
		};
		refresh();
		window.addEventListener("mantine-local-storage", refresh);
		window.addEventListener("storage", refresh);
		return () => {
			window.removeEventListener("mantine-local-storage", refresh);
			window.removeEventListener("storage", refresh);
		};
	}, [enabled, connectionId, idsKey, tables]);
	return index;
}
