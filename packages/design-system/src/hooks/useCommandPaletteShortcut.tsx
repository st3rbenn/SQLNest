import { useHotkeys } from "@mantine/hooks";

/**
 * Bind Cmd/Ctrl+K globalement pour ouvrir la command palette.
 *
 * `mod` = Cmd (Mac) / Ctrl (Win/Linux) — OS-adaptatif built-in Mantine.
 *
 * Le tableau vide `[]` en 2e arg override le comportement par défaut de
 * `useHotkeys` (skip INPUT/TEXTAREA/SELECT) : la palette est un outil
 * top-level accessible **de n'importe où**, y compris depuis un input
 * (recherche dans le SchemaTree, éditeur SNQL…). Sans ça, un user qui a
 * le curseur dans un champ ne peut plus l'ouvrir → friction.
 *
 * `preventDefault: true` : Firefox bind Cmd+K sur la searchbar navigateur ;
 * on kidnappe.
 */
export function useCommandPaletteShortcut(onOpen: () => void): void {
	useHotkeys(
		[["mod+K", () => onOpen(), { preventDefault: true }]],
		[] // aucun tag ignoré → fire même dans les inputs
	);
}
