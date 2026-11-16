import { useMemo } from "react";

/**
 * Rend le même objet tant qu'aucun de ses champs ne change. Pour une valeur
 * de contexte assemblée à chaque rendu : ses consommateurs ne re-rendent
 * que si un champ a réellement bougé. Les champs doivent rester les mêmes
 * d'un rendu à l'autre.
 */
export function useShallowMemo<T extends object>(value: T): T {
	// biome-ignore lint/correctness/useExhaustiveDependencies: l'objet change quand un de ses champs change
	return useMemo(() => value, Object.values(value));
}
