import {
	FloatingPanel,
	showNotification,
	Toolbar,
	ToolbarButton
} from "@sqlnest/design-system";
import {
	IconArrowsShuffle,
	IconDeviceFloppy,
	IconDownload,
	IconHistory,
	IconMessage,
	IconMoon,
	IconPointer,
	IconSparkles,
	IconSquareDashed,
	IconTerminal2
} from "@tabler/icons-react";
import { useState } from "react";

export type CanvasTool = "select" | "frame";
type LocalTool = CanvasTool | "comment";

const notImplemented = (label: string) =>
	showNotification({
		title: label,
		message: "Bientôt disponible.",
		color: "amber",
		autoClose: 2500
	});

interface Props {
	readonly onAutoLayout?: () => void;
	/** Décalage supplémentaire depuis le bas (px) — utilisé par SchemaCanvas
	 * pour remonter la toolbar au-dessus de la console SNQL quand elle est
	 * ouverte. */
	readonly bottomOffset?: number;
	/** Outil actif du canvas — piloté par le parent car il conditionne des
	 * comportements RF (cursor, action au release du lasso, etc.). */
	readonly activeTool: CanvasTool;
	readonly onSelectTool: (tool: CanvasTool) => void;
	/** T5 : crée un node console SNQL au centre du viewport courant. */
	readonly onCreateConsole?: () => void;
	readonly onOpenHistory?: () => void;
}

const ICON = { size: 18, stroke: 1.8 } as const;

/** Toolbar horizontale du canvas Schéma — flottante en bas-centre. */
export function CanvasToolbar({
	onAutoLayout,
	bottomOffset = 0,
	activeTool,
	onSelectTool,
	onCreateConsole,
	onOpenHistory
}: Props) {
	// Le tool « comment » reste local — pas d'implémentation côté canvas
	// donc pas la peine de le remonter. Basculer sur select/frame quitte
	// l'affichage `comment` de la toolbar (cohérent visuellement).
	const [localComment, setLocalComment] = useState(false);
	const displayTool: LocalTool = localComment ? "comment" : activeTool;
	const selectCanvasTool = (t: CanvasTool) => {
		setLocalComment(false);
		onSelectTool(t);
	};
	return (
		<FloatingPanel
			position="bottom-center"
			offset={{ x: 0, y: 16 + bottomOffset }}
			p={0}
			withBorder={false}
			shadow="none"
			bg="transparent"
		>
			<Toolbar orientation="horizontal" aria-label="Canvas actions">
				<ToolbarButton
					label="Sélection (V)"
					active={displayTool === "select"}
					onClick={() => selectCanvasTool("select")}
				>
					<IconPointer {...ICON} />
				</ToolbarButton>
				<ToolbarButton
					label="Créer un frame (F)"
					active={displayTool === "frame"}
					onClick={() => selectCanvasTool("frame")}
				>
					<IconSquareDashed {...ICON} />
				</ToolbarButton>
				<ToolbarButton
					label="Console SNQL (C)"
					onClick={() => {
						if (onCreateConsole) onCreateConsole();
						else notImplemented("Console");
					}}
				>
					<IconTerminal2 {...ICON} />
				</ToolbarButton>
				<ToolbarButton
					label="Annoter (bientôt)"
					active={displayTool === "comment"}
					onClick={() => {
						setLocalComment(true);
						notImplemented("Annotations");
					}}
				>
					<IconMessage {...ICON} />
				</ToolbarButton>
				<Toolbar.Divider orientation="horizontal" />
				<ToolbarButton
					label="Relayoute auto"
					onClick={() => {
						if (onAutoLayout) onAutoLayout();
						else notImplemented("Relayoute auto");
					}}
				>
					<IconArrowsShuffle {...ICON} />
				</ToolbarButton>
				<ToolbarButton
					label="Historique du schéma"
					onClick={() => {
						if (onOpenHistory) onOpenHistory();
						else notImplemented("Historique");
					}}
				>
					<IconHistory {...ICON} />
				</ToolbarButton>
				<ToolbarButton
					label="IA (bientôt)"
					statusDot="warning"
					onClick={() => notImplemented("IA")}
				>
					<IconSparkles {...ICON} />
				</ToolbarButton>
				<Toolbar.Divider orientation="horizontal" />
				<ToolbarButton
					label="Exporter"
					onClick={() => notImplemented("Export")}
				>
					<IconDownload {...ICON} />
				</ToolbarButton>
				<ToolbarButton
					label="Enregistrer"
					onClick={() => notImplemented("Enregistrer")}
				>
					<IconDeviceFloppy {...ICON} />
				</ToolbarButton>
				<ToolbarButton label="Thème" onClick={() => notImplemented("Thème")}>
					<IconMoon {...ICON} />
				</ToolbarButton>
			</Toolbar>
		</FloatingPanel>
	);
}
