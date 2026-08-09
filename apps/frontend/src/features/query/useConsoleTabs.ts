/**
 * Multi-tabs de la console SNQL, persistés par `connectionId` en
 * localStorage. Chaque tab porte son propre source SNQL + éventuellement
 * les métadonnées du dernier run (row count, timing) pour l'afficher
 * dans la tab bar en badge.
 *
 * Persistance :
 *   clé `sqlnest.console.tabs.<connId>` → `{ tabs, activeTabId }`
 *
 * Auto-crée un tab défaut "Sans titre" au premier mount si aucun state
 * existant. Le dernier tab ne peut pas être fermé (fallback : reset son
 * source à vide plutôt).
 */

import { useLocalStorage } from "@mantine/hooks";
import { useCallback } from "react";

export interface ConsoleTabLastResult {
	readonly rowCount: number;
	readonly timingMs: number;
}

export interface ConsoleTab {
	readonly id: string;
	readonly name: string;
	readonly source: string;
	readonly lastResult?: ConsoleTabLastResult;
}

export interface ConsoleState {
	readonly tabs: readonly ConsoleTab[];
	readonly activeTabId: string;
}

function makeId(): string {
	// crypto.randomUUID est disponible sur tous les browsers modernes de
	// notre target (Chrome 92+, Firefox 95+, Safari 15.4+). Fallback
	// Math.random pour les env qui n'en ont pas (jsdom en test).
	if (
		typeof crypto !== "undefined" &&
		typeof crypto.randomUUID === "function"
	) {
		return crypto.randomUUID();
	}
	return `tab-${Math.random().toString(36).slice(2, 10)}`;
}

function makeDefaultState(): ConsoleState {
	const first: ConsoleTab = { id: makeId(), name: "Sans titre", source: "" };
	return { tabs: [first], activeTabId: first.id };
}

export interface UseConsoleTabsApi {
	readonly state: ConsoleState;
	readonly activeTab: ConsoleTab;
	readonly newTab: () => void;
	readonly closeTab: (id: string) => void;
	readonly renameTab: (id: string, name: string) => void;
	readonly updateSource: (id: string, source: string) => void;
	readonly setLastResult: (id: string, result: ConsoleTabLastResult) => void;
	readonly setActive: (id: string) => void;
	readonly reorderTabs: (fromId: string, toId: string) => void;
}

export function useConsoleTabs(connectionId: string): UseConsoleTabsApi {
	const [state, setState] = useLocalStorage<ConsoleState>({
		key: `sqlnest.console.tabs.${connectionId}`,
		defaultValue: makeDefaultState(),
		getInitialValueInEffect: false
	});

	// Guard : si le localStorage contient un state corrompu ou vide, on
	// répare silencieusement (au moins un tab, activeTabId cohérent).
	const safeState: ConsoleState =
		state.tabs.length === 0
			? makeDefaultState()
			: state.tabs.some((t) => t.id === state.activeTabId)
				? state
				: { ...state, activeTabId: state.tabs[0]?.id ?? "" };

	const activeTab =
		safeState.tabs.find((t) => t.id === safeState.activeTabId) ??
		safeState.tabs[0];
	if (activeTab === undefined) {
		// Impossible en pratique vu le guard ci-dessus, mais TS l'exige.
		throw new Error("useConsoleTabs: état incohérent (0 tab)");
	}

	const newTab = useCallback(() => {
		setState((s) => {
			const nextIndex = s.tabs.length + 1;
			const tab: ConsoleTab = {
				id: makeId(),
				name: `Query ${nextIndex}`,
				source: ""
			};
			return { tabs: [...s.tabs, tab], activeTabId: tab.id };
		});
	}, [setState]);

	const closeTab = useCallback(
		(id: string) => {
			setState((s) => {
				if (s.tabs.length <= 1) {
					// Dernier tab : au lieu de fermer, reset le source à vide.
					return {
						...s,
						tabs: s.tabs.map((t) =>
							t.id === id ? { ...t, source: "", lastResult: undefined } : t
						)
					};
				}
				const idx = s.tabs.findIndex((t) => t.id === id);
				if (idx === -1) return s;
				const nextTabs = s.tabs.filter((t) => t.id !== id);
				// Si on ferme l'actif, active le voisin gauche (ou le premier).
				const nextActive =
					s.activeTabId === id
						? (nextTabs[Math.max(0, idx - 1)]?.id ?? nextTabs[0]?.id ?? "")
						: s.activeTabId;
				return { tabs: nextTabs, activeTabId: nextActive };
			});
		},
		[setState]
	);

	const renameTab = useCallback(
		(id: string, name: string) => {
			setState((s) => ({
				...s,
				tabs: s.tabs.map((t) => (t.id === id ? { ...t, name } : t))
			}));
		},
		[setState]
	);

	const updateSource = useCallback(
		(id: string, source: string) => {
			setState((s) => ({
				...s,
				tabs: s.tabs.map((t) => (t.id === id ? { ...t, source } : t))
			}));
		},
		[setState]
	);

	const setLastResult = useCallback(
		(id: string, result: ConsoleTabLastResult) => {
			setState((s) => ({
				...s,
				tabs: s.tabs.map((t) =>
					t.id === id ? { ...t, lastResult: result } : t
				)
			}));
		},
		[setState]
	);

	const setActive = useCallback(
		(id: string) => {
			setState((s) =>
				s.tabs.some((t) => t.id === id) ? { ...s, activeTabId: id } : s
			);
		},
		[setState]
	);

	const reorderTabs = useCallback(
		(fromId: string, toId: string) => {
			if (fromId === toId) return;
			setState((s) => {
				const from = s.tabs.findIndex((t) => t.id === fromId);
				const to = s.tabs.findIndex((t) => t.id === toId);
				if (from === -1 || to === -1) return s;
				const next = s.tabs.slice();
				const [moved] = next.splice(from, 1);
				if (moved === undefined) return s;
				next.splice(to, 0, moved);
				return { ...s, tabs: next };
			});
		},
		[setState]
	);

	return {
		state: safeState,
		activeTab,
		newTab,
		closeTab,
		renameTab,
		updateSource,
		setLastResult,
		setActive,
		reorderTabs
	};
}
