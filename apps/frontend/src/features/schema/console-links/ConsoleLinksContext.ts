import { useLocalStorage } from "@mantine/hooks";
import { createContext } from "react";
import type { ConsoleEntry } from "./useConsoleIndex";

export interface ConsoleLinksValue {
	readonly byTable: ReadonlyMap<string, readonly ConsoleEntry[]>;
	/** Consoles rattachées à une table : repliées tant qu'elles ne sont pas ouvertes. */
	readonly attached: ReadonlySet<string>;
	readonly openId: string | null;
	readonly open: (id: string) => void;
	readonly fold: () => void;
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
