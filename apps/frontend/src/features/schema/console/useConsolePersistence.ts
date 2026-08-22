import { useEffect, useState } from "react";

type Engine = "postgres" | "mongodb";

const CONSOLE_LS_KEY = "sqlnest:canvas-console:source";
const CONSOLE_HEIGHT_LS_KEY = "sqlnest:canvas-console:height";
/** History clé scopée par connectionId — pas de leak dev→prod
 * cross-connection. Global fallback pour rétrocompatibilité (canvas
 * console éphémère sans connId). */
const CONSOLE_HISTORY_LS_KEY = "sqlnest:canvas-console:history";
function historyKeyFor(connectionId: string | undefined): string {
	if (connectionId === undefined) return CONSOLE_HISTORY_LS_KEY;
	return `${CONSOLE_HISTORY_LS_KEY}:${connectionId}`;
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

const EXAMPLES: Record<Engine, string> = {
	postgres: "get <table> pick <fields>",
	mongodb: "get <collection> pick <fields>"
};

/**
 * Charge l'history depuis localStorage avec migration soft des anciennes
 * entrées string[] → HistoryEntry[]. Tolérant aux JSON corrompus, quota,
 * private mode — retombe sur [] sans throw.
 */
function loadHistory(storageKey: string): readonly HistoryEntry[] {
	if (typeof window === "undefined") return [];
	try {
		const raw = window.localStorage.getItem(storageKey);
		if (raw === null) return [];
		const parsed = JSON.parse(raw);
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

export function consoleExampleFor(engine: Engine): string {
	return EXAMPLES[engine];
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
	engine: Engine,
	connectionId?: string
): ConsolePersistence {
	const historyStorageKey = historyKeyFor(connectionId);
	const [source, setSource] = useState<string>(() => {
		if (typeof window === "undefined") return EXAMPLES[engine];
		try {
			return window.localStorage.getItem(CONSOLE_LS_KEY) ?? EXAMPLES[engine];
		} catch {
			return EXAMPLES[engine];
		}
	});
	useEffect(() => {
		if (typeof window === "undefined") return;
		try {
			window.localStorage.setItem(CONSOLE_LS_KEY, source);
		} catch {
			/* quota / private mode */
		}
	}, [source]);

	const [height, setHeight] = useState<number>(() => {
		if (typeof window === "undefined") return CONSOLE_HEIGHT_EXPANDED_DEFAULT;
		try {
			const raw = window.localStorage.getItem(CONSOLE_HEIGHT_LS_KEY);
			if (raw !== null) {
				const n = Number(raw);
				if (
					Number.isFinite(n) &&
					n >= CONSOLE_HEIGHT_MIN &&
					n <= maxConsoleHeight()
				)
					return n;
			}
		} catch {
			/* storage indispo */
		}
		return CONSOLE_HEIGHT_EXPANDED_DEFAULT;
	});
	useEffect(() => {
		if (typeof window === "undefined") return;
		try {
			window.localStorage.setItem(CONSOLE_HEIGHT_LS_KEY, String(height));
		} catch {
			/* quota / private mode */
		}
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
		if (typeof window === "undefined") return;
		try {
			window.localStorage.setItem(
				historyStorageKey,
				JSON.stringify(history)
			);
		} catch {
			/* quota / private mode */
		}
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
