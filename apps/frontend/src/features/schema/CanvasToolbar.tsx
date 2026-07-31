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
	IconLasso,
	IconMessage,
	IconMoon,
	IconPointer,
	IconSparkles,
	IconSquareDashed,
	IconVersions
} from "@tabler/icons-react";
import { useState } from "react";

type Tool = "select" | "frame" | "lasso" | "comment";

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
}

const ICON = { size: 18, stroke: 1.8 } as const;

/** Toolbar horizontale du canvas Schéma — flottante en bas-centre. */
export function CanvasToolbar({ onAutoLayout, bottomOffset = 0 }: Props) {
	const [tool, setTool] = useState<Tool>("select");
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
					active={tool === "select"}
					onClick={() => setTool("select")}
				>
					<IconPointer {...ICON} />
				</ToolbarButton>
				<ToolbarButton
					label="Créer un frame (F)"
					active={tool === "frame"}
					onClick={() => {
						setTool("frame");
						notImplemented("Création de frame");
					}}
				>
					<IconSquareDashed {...ICON} />
				</ToolbarButton>
				<ToolbarButton
					label="Lasso multi-sélection"
					active={tool === "lasso"}
					onClick={() => {
						setTool("lasso");
						notImplemented("Lasso");
					}}
				>
					<IconLasso {...ICON} />
				</ToolbarButton>
				<ToolbarButton
					label="Annoter (bientôt)"
					active={tool === "comment"}
					onClick={() => {
						setTool("comment");
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
					label="Diff schémas (bientôt)"
					statusDot="warning"
					onClick={() => notImplemented("Diff schémas")}
				>
					<IconVersions {...ICON} />
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
				<ToolbarButton label="Enregistrer" onClick={() => notImplemented("Enregistrer")}>
					<IconDeviceFloppy {...ICON} />
				</ToolbarButton>
				<ToolbarButton label="Thème" onClick={() => notImplemented("Thème")}>
					<IconMoon {...ICON} />
				</ToolbarButton>
			</Toolbar>
		</FloatingPanel>
	);
}
