import { useSyncExternalStore } from "react";

/**
 * Détecte si la plateforme est Mac (Cmd = modifier principal) plutôt que
 * Windows/Linux (Ctrl = modifier principal). Basé sur `navigator.platform`
 * en priorité (fiable même dans les webviews custom), fallback userAgent.
 *
 * SSR-safe : retourne `false` (défaut Ctrl) côté serveur — l'affichage
 * s'ajuste au 1er render client via `useSyncExternalStore`.
 */
function detectIsMac(): boolean {
	if (typeof navigator === "undefined") return false;
	const platform =
		(navigator as unknown as { userAgentData?: { platform?: string } })
			.userAgentData?.platform ??
		navigator.platform ??
		"";
	if (platform.toLowerCase().includes("mac")) return true;
	// Fallback userAgent (couvre les cas où platform est vide ou trompeur,
	// ex. iPadOS 13+ qui se déclare comme MacIntel).
	return /Mac|iPod|iPhone|iPad/.test(navigator.userAgent ?? "");
}

// `platform` ne change pas au runtime — on peut retourner un snapshot fixe
// et un subscribe no-op. Le seul intérêt du store est SSR-safety : le server
// retourne false, le client peut retourner true au mount.
const subscribe = (): (() => void) => () => {};

function useIsMac(): boolean {
	return useSyncExternalStore(
		subscribe,
		detectIsMac,
		() => false, // server snapshot
	);
}

/**
 * Label du modifier principal à afficher dans les hints / tooltips / pills :
 * `⌘` sur Mac, `Ctrl` sur Windows/Linux. Pair avec `useCommandPaletteShortcut`
 * et autres bindings qui sont déjà OS-agnostic via `e.metaKey || e.ctrlKey`.
 */
export function useModKeyLabel(): string {
	return useIsMac() ? "⌘" : "Ctrl";
}
