import { useEffect, useState } from "react";

type Engine = "postgres" | "mongodb";

const CONSOLE_LS_KEY = "sqlnest:canvas-console:source";
const CONSOLE_HEIGHT_LS_KEY = "sqlnest:canvas-console:height";
const CONSOLE_HISTORY_LS_KEY = "sqlnest:canvas-console:history";
const HISTORY_MAX = 20;
export const CONSOLE_HEIGHT_MIN = 180;
export const CONSOLE_HEIGHT_EXPANDED_DEFAULT = 340;

const EXAMPLES: Record<Engine, string> = {
	postgres: "get <table> | pick <fields>",
	mongodb: "get <collection> | pick <fields>"
};

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
	readonly history: readonly string[];
	readonly addHistory: (q: string) => void;
	readonly clearHistory: () => void;
}

/**
 * Persistance locale de la CanvasConsole (source + hauteur + historique).
 * Une seule slot globale — pas de scoping par engine/schéma : c'est une
 * console rapide, la page /query reste l'endroit pour les vraies sessions.
 */
export function useConsolePersistence(engine: Engine): ConsolePersistence {
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

	const [history, setHistory] = useState<readonly string[]>(() => {
		if (typeof window === "undefined") return [];
		try {
			const raw = window.localStorage.getItem(CONSOLE_HISTORY_LS_KEY);
			if (raw !== null) {
				const parsed = JSON.parse(raw);
				if (Array.isArray(parsed)) {
					return parsed.filter((x): x is string => typeof x === "string");
				}
			}
		} catch {
			/* storage indispo / JSON corrompu */
		}
		return [];
	});
	useEffect(() => {
		if (typeof window === "undefined") return;
		try {
			window.localStorage.setItem(
				CONSOLE_HISTORY_LS_KEY,
				JSON.stringify(history)
			);
		} catch {
			/* quota / private mode */
		}
	}, [history]);

	const addHistory = (q: string) => {
		setHistory((prev) => {
			const dedup = prev.filter((x) => x !== q);
			return [q, ...dedup].slice(0, HISTORY_MAX);
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
