import { useLocalStorage } from "@mantine/hooks";
import { createContext } from "react";
import type { ConsoleEntry } from "./useConsoleIndex";

/** `beside` : à droite de sa table ; `inPlace` : là où elle était. */
export type ConsolePlacement = "beside" | "inPlace";

export interface ConsoleLinksValue {
	readonly byTable: ReadonlyMap<string, readonly ConsoleEntry[]>;
	/** Consoles rattachées à une table : repliées tant qu'elles ne sont pas ouvertes. */
	readonly attached: ReadonlySet<string>;
	/** Consoles dépliées : plusieurs peuvent l'être à la fois. */
	readonly openIds: ReadonlySet<string>;
	readonly open: (id: string, placement: ConsolePlacement) => void;
	readonly fold: (id: string) => void;
	readonly createFor: (table: string) => void;
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
