import type { SpotlightActionGroupData } from "@sqlnest/design-system";
import { colorFor } from "./colors";
import type { SchemaModel } from "./schema-model";

export interface CanvasCommandCallbacks {
	readonly onFocusTable: (name: string) => void;
	readonly onOpenInEditor: (name: string) => void;
	readonly onFitView: () => void;
	readonly onAskAi: () => void;
	readonly onToggleTheme: () => void;
}

/** Construit les groupes d'actions de la palette Cmd+K (tour 1c). Pur → testable. */
export function buildCanvasCommands(
	schema: SchemaModel,
	cbs: CanvasCommandCallbacks
): SpotlightActionGroupData[] {
	const tableActions = schema.collections.map((c) => {
		const color = colorFor(c.name);
		return {
			id: `table:${c.name}`,
			label: c.name,
			description: `${c.fields.length} champ${c.fields.length > 1 ? "s" : ""}${
				c.source === "inferred" ? " · inféré" : ""
			}`,
			keywords: [c.name, ...c.fields.map((f) => f.name)],
			onClick: () => cbs.onFocusTable(c.name),
			leftSection: (
				<span
					aria-hidden
					style={{
						display: "inline-block",
						width: 8,
						height: 8,
						borderRadius: 2,
						background: color.border,
						flexShrink: 0
					}}
				/>
			)
		};
	});

	const editorActions = schema.collections.map((c) => ({
		id: `open:${c.name}`,
		label: `Ouvrir ${c.name} dans l'éditeur`,
		description: `get ${c.name}`,
		keywords: ["ouvrir", "éditeur", "editor", "query", c.name],
		onClick: () => cbs.onOpenInEditor(c.name)
	}));

	const canvasActions = [
		{
			id: "fit-view",
			label: "Ajuster la vue",
			description: "Recadre le canvas sur toutes les tables visibles",
			keywords: ["fit", "zoom", "vue", "reset"],
			onClick: () => cbs.onFitView()
		},
		{
			id: "ask-ai",
			label: "Demander à l'IA",
			description: "Générer une requête SNQL — bientôt",
			keywords: ["ia", "ai", "llm", "suggestion", "génération"],
			onClick: () => cbs.onAskAi()
		},
		{
			id: "toggle-theme",
			label: "Basculer le thème sombre",
			description: "Bientôt disponible",
			keywords: ["dark", "sombre", "clair", "theme", "thème"],
			onClick: () => cbs.onToggleTheme()
		}
	];

	return [
		{ group: "Tables", actions: tableActions },
		{ group: "Ouvrir dans l'éditeur", actions: editorActions },
		{ group: "Actions canvas", actions: canvasActions }
	];
}
