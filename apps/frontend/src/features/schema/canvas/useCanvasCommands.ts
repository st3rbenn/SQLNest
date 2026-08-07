import {
	type SpotlightActionGroupData,
	showNotification,
	spotlight,
	useCommandPaletteShortcut
} from "@sqlnest/design-system";
import { useMemo } from "react";
import { buildCanvasCommands } from "../commands";
import type { SchemaModel } from "../schema-model";

export interface UseCanvasCommandsOptions {
	readonly schema: SchemaModel;
	readonly onFocusTable: (name: string) => void;
	readonly onFitView: () => void;
}

export interface UseCanvasCommandsReturn {
	/** Groupes d'actions pour `<Spotlight />` — tables + actions canvas. */
	readonly commandGroups: SpotlightActionGroupData[];
}

/**
 * Assemble la « command surface » du canvas :
 *   - `useCommandPaletteShortcut` — attache Cmd/Ctrl+K → `spotlight.open`.
 *   - `commandGroups` — items palette (tables du schema + actions
 *     `Ajuster la vue`, `Demander à l'IA`, `Basculer le thème`).
 *
 * Les 2 dernières actions ne sont pas branchées (roadmap IA + dark mode
 * repoussés) — le hook affiche une notification « bientôt disponible »
 * plutôt que d'appeler des callbacks parents qui feraient la même chose.
 * Regroupe tout ce qui touche à la palette en un seul point d'ajout :
 * une nouvelle commande = 1 endroit ici + éventuellement `buildCanvasCommands`.
 */
export function useCanvasCommands(
	opts: UseCanvasCommandsOptions
): UseCanvasCommandsReturn {
	const { schema, onFocusTable, onFitView } = opts;

	useCommandPaletteShortcut(spotlight.open);

	const commandGroups = useMemo(
		() =>
			buildCanvasCommands(schema, {
				onFocusTable,
				onFitView,
				onAskAi: () =>
					showNotification({
						title: "Demander à l'IA",
						message: "Bientôt disponible.",
						color: "amber",
						autoClose: 2000
					}),
				onToggleTheme: () =>
					showNotification({
						title: "Thème sombre",
						message: "Bientôt disponible.",
						color: "amber",
						autoClose: 2000
					})
			}),
		// biome-ignore lint/correctness/useExhaustiveDependencies: onFocusTable/onFitView sont assez stables pour la durée de vie de la palette
		[schema]
	);

	return { commandGroups };
}
