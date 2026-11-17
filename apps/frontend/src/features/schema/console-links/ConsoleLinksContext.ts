import { useLocalStorage } from "@mantine/hooks";
import { createContext } from "react";
import type { ConsoleEntry } from "./useConsoleIndex";

/** Point du canvas, en coordonnées flow. */
export interface FlowPoint {
	readonly x: number;
	readonly y: number;
}

/** `beside` : à la place libre la plus proche de sa table ; `inPlace` : là
 * où elle était ; un point : celui d'un dépôt, la console se pose juste
 * au-dessus, centrée (le milieu de son bord bas sur le point). */
export type ConsolePlacement = "beside" | "inPlace" | FlowPoint;

export interface ConsoleLinksValue {
	readonly byTable: ReadonlyMap<string, readonly ConsoleEntry[]>;
	/** Consoles rattachées à une table : repliées tant qu'elles ne sont pas ouvertes. */
	readonly attached: ReadonlySet<string>;
	/** Table de départ de chaque console rattachée. */
	readonly rootOf: ReadonlyMap<string, string>;
	/** Consoles dépliées : plusieurs peuvent l'être à la fois. */
	readonly openIds: ReadonlySet<string>;
	readonly open: (id: string, placement: ConsolePlacement) => void;
	readonly fold: (id: string) => void;
	/** Nouvelle console de la table : à côté d'elle, ou déposée au point `at`. */
	readonly createFor: (table: string, at?: FlowPoint) => void;
}

/** `null` : prototype éteint, le canvas garde ses consoles en frames libres. */
export const ConsoleLinksContext = createContext<ConsoleLinksValue | null>(
	null
);

/** Interrupteur du prototype « console rattachée à sa table », éteint par défaut. */
export function useConsoleLinksFlag(): readonly [
	boolean,
	(value: boolean) => void
] {
	const [enabled, setEnabled] = useLocalStorage<boolean>({
		key: "sqlnest:proto:console-links",
		defaultValue: false,
		getInitialValueInEffect: false
	});
	return [enabled, setEnabled];
}
