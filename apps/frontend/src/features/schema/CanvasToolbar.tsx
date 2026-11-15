import {
	FloatingPanel,
	showNotification,
	Toolbar,
	ToolbarButton
} from "@sqlnest/design-system";
import {
	IconArrowsShuffle,
	IconLink,
	IconPointer,
	IconSquareDashed,
	IconTerminal2
} from "@tabler/icons-react";

export type CanvasTool = "select" | "frame";

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
	 * comportements du canvas (cursor, action au release du lasso, etc.). */
	readonly activeTool: CanvasTool;
	readonly onSelectTool: (tool: CanvasTool) => void;
	/** T5 : crée un node console SNQL au centre du viewport courant. */
	readonly onCreateConsole?: () => void;
	/** Bascule le panneau d'inférence de relations. Absent (base avec FK) →
	 * le bouton n'est pas rendu (rien à inférer). */
	readonly onToggleInference?: () => void;
	/** Panneau d'inférence ouvert → bouton en état actif. */
	readonly inferenceActive?: boolean;
}

const ICON = { size: 18, stroke: 1.8 } as const;

/** Toolbar horizontale du canvas Schéma — flottante en bas-centre. */
export function CanvasToolbar({
	onAutoLayout,
	bottomOffset = 0,
	activeTool,
	onSelectTool,
	onCreateConsole,
	onToggleInference,
	inferenceActive = false
}: Props) {
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
					active={activeTool === "select"}
					onClick={() => onSelectTool("select")}
				>
					<IconPointer {...ICON} />
				</ToolbarButton>
				<ToolbarButton
					label="Créer un frame (F)"
					active={activeTool === "frame"}
					onClick={() => onSelectTool("frame")}
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
				{onToggleInference ? (
					<ToolbarButton
						label="Inférer les liens"
						active={inferenceActive}
						onClick={onToggleInference}
					>
						<IconLink {...ICON} />
					</ToolbarButton>
				) : null}
			</Toolbar>
		</FloatingPanel>
	);
}
