import { useEffect, useState } from "react";
import {
	connectionKey,
	readJson,
	readText,
	storageKeys,
	writeJson,
	writeText
} from "../../storage/localStore";

/** History clé scopée par connectionId — pas de leak dev→prod
 * cross-connection. Global fallback pour rétrocompatibilité (canvas
 * console éphémère sans connId). */
function historyKeyFor(connectionId: string | undefined): string {
	if (connectionId === undefined) return storageKeys.canvasConsoleHistory;
	return connectionKey("canvas-console:history", connectionId);
}
const HISTORY_MAX = 20;

/**
 * Une entrée de l'historique — la source SNQL du run + les metadata
 * rendu-side pour permettre le badge distinct dans l'UI history :
 *  - `written` : le run était une écriture (INSERT/UPDATE/DELETE/upsert)
 *  - `rolledBack` : la tx a été annulée (rollback_user OU rollback_error
 *    via classifyRuntimeError)
 *  - `at` : timestamp ms — pour un tri chronologique explicite si besoin
 *    (liste implicitement most-recent-first via unshift dans addHistory)
 *
 * Migration soft : les anciennes entrées string du localStorage sont
 * upgradées silencieusement en `{source: entry}` au load.
 */
export interface HistoryEntry {
	readonly source: string;
	readonly written?: boolean;
	readonly rolledBack?: boolean;
	readonly at?: number;
}

/** Meta optionnel passé à `addHistory(source, meta?)`. Le source seul reste
 * accepté pour les consumers legacy — le hook enveloppe automatiquement en
 * HistoryEntry. */
export interface AddHistoryMeta {
	readonly written?: boolean;
	readonly rolledBack?: boolean;
	readonly at?: number;
}
export const CONSOLE_HEIGHT_MIN = 180;
export const CONSOLE_HEIGHT_EXPANDED_DEFAULT = 340;

/** Mongo parle de collections ; les autres moteurs, de tables. */
function exampleFor(engine: string): string {
	return engine === "mongodb"
		? "get <collection> pick <fields>"
		: "get <table> pick <fields>";
}

/**
 * Charge l'history depuis localStorage avec migration soft des anciennes
 * entrées string[] → HistoryEntry[]. Tolérant aux JSON corrompus, quota,
 * private mode — retombe sur [] sans throw.
 */
function loadHistory(storageKey: string): readonly HistoryEntry[] {
	try {
		const parsed = readJson(storageKey);
		if (!Array.isArray(parsed)) return [];
		return parsed
			.map((entry): HistoryEntry | null => {
				// Legacy string entry → wrap.
				if (typeof entry === "string") return { source: entry };
				// New HistoryEntry object — check source obligatoire.
				if (
					entry !== null &&
					typeof entry === "object" &&
					typeof (entry as Record<string, unknown>).source === "string"
				) {
					const e = entry as Record<string, unknown>;
					return {
						source: e.source as string,
						...(typeof e.written === "boolean"
							? { written: e.written }
							: {}),
						...(typeof e.rolledBack === "boolean"
							? { rolledBack: e.rolledBack }
							: {}),
						...(typeof e.at === "number" ? { at: e.at } : {})
					};
				}
				return null;
			})
			.filter((x): x is HistoryEntry => x !== null);
	} catch {
		return [];
	}
}

/** Max = presque tout le viewport (laisse ~80 px pour la toolbar + marges).
 *  Calculé au drag time pour suivre les changements de fenêtre. */
export function maxConsoleHeight(): number {
	if (typeof window === "undefined") return 800;
	return Math.max(CONSOLE_HEIGHT_MIN, window.innerHeight - 80);
}

export function consoleExampleFor(engine: string): string {
	return exampleFor(engine);
}

export interface ConsolePersistence {
	readonly source: string;
	readonly setSource: (s: string) => void;
	readonly height: number;
	readonly setHeight: (h: number) => void;
	readonly history: readonly HistoryEntry[];
	readonly addHistory: (source: string, meta?: AddHistoryMeta) => void;
	readonly clearHistory: () => void;
}

/**
 * Persistance locale de la CanvasConsole (source + hauteur + historique).
 * History scopé par connectionId : pas de leak dev→prod cross-connection.
 * `connectionId` absent → clé globale (rétrocompat + canvas console
 * éphémère sans connexion active).
 */
export function useConsolePersistence(
	engine: string,
	connectionId?: string
): ConsolePersistence {
	const historyStorageKey = historyKeyFor(connectionId);
	const [source, setSource] = useState<string>(() => {
		return readText(storageKeys.canvasConsoleSource) ?? exampleFor(engine);
	});
	useEffect(() => {
		writeText(storageKeys.canvasConsoleSource, source);
	}, [source]);

	const [height, setHeight] = useState<number>(() => {
		const raw = readText(storageKeys.canvasConsoleHeight);
		if (raw !== null) {
			const n = Number(raw);
			if (
				Number.isFinite(n) &&
				n >= CONSOLE_HEIGHT_MIN &&
				n <= maxConsoleHeight()
			)
				return n;
		}
		return CONSOLE_HEIGHT_EXPANDED_DEFAULT;
	});
	useEffect(() => {
		writeText(storageKeys.canvasConsoleHeight, String(height));
	}, [height]);

	// Load history — migration soft depuis old string[] vers
	// HistoryEntry[]. Chaque string devient `{source: entry}` sans perte.
	// Ré-init sur changement de connectionId (nouvelle key → nouveau
	// state, évite le leak cross-connection).
	const [history, setHistory] = useState<readonly HistoryEntry[]>(() =>
		loadHistory(historyStorageKey)
	);
	useEffect(() => {
		// Ré-charge quand la clé change (switch de connection). Les storage
		// events cross-tab ne sont pas écoutés — le BroadcastChannel
		// pourrait s'étendre à ça plus tard si besoin.
		setHistory(loadHistory(historyStorageKey));
	}, [historyStorageKey]);
	useEffect(() => {
		writeJson(historyStorageKey, history);
	}, [history, historyStorageKey]);

	const addHistory = (source: string, meta?: AddHistoryMeta) => {
		setHistory((prev) => {
			// Dédup par source — le run le plus récent l'emporte (déplace en
			// tête + refresh meta).
			const dedup = prev.filter((e) => e.source !== source);
			const entry: HistoryEntry = {
				source,
				...(meta?.written !== undefined ? { written: meta.written } : {}),
				...(meta?.rolledBack !== undefined
					? { rolledBack: meta.rolledBack }
					: {}),
				...(meta?.at !== undefined ? { at: meta.at } : {})
			};
			return [entry, ...dedup].slice(0, HISTORY_MAX);
		});
	};
	const clearHistory = () => setHistory([]);

	return {
		source,
		setSource,
		height,
		setHeight,
		history,
		addHistory,
		clearHistory
	};
}
