import {
	FloatingPanel,
	showNotification,
	Toolbar,
	ToolbarButton
} from "@sqlnest/design-system";
import { useState } from "react";

type Tool = "select" | "frame" | "lasso" | "comment";

const notImplemented = (label: string) =>
	showNotification({
		title: label,
		message: "Bientôt disponible.",
		color: "amber",
		autoClose: 2500
	});

const Cursor = () => (
	<svg width={16} height={16} viewBox="0 0 24 24" fill="currentColor">
		<title>Sélection</title>
		<path d="M4 2l14 8-6 2-2 6z" />
	</svg>
);
const Frame = () => (
	<svg
		width={16}
		height={16}
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		strokeWidth={2}
	>
		<title>Frame</title>
		<rect x={4} y={4} width={16} height={16} rx={2} strokeDasharray="3 3" />
	</svg>
);
const Lasso = () => (
	<svg
		width={16}
		height={16}
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		strokeWidth={2}
	>
		<title>Lasso</title>
		<path d="M4 8c0-3 4-5 8-5s8 2 8 5-4 5-8 5c-2 0-4-1-5-1" />
		<path d="M7 14v4a2 2 0 002 2h.5" />
	</svg>
);
const Comment = () => (
	<svg
		width={16}
		height={16}
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		strokeWidth={2}
	>
		<title>Annoter</title>
		<path d="M4 5h16v10H10l-4 4V5z" />
	</svg>
);
const AutoLayout = () => (
	<svg
		width={16}
		height={16}
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		strokeWidth={2}
	>
		<title>Auto-layout</title>
		<circle cx={6} cy={6} r={2} />
		<circle cx={18} cy={6} r={2} />
		<circle cx={12} cy={18} r={2} />
		<path d="M6 8v3M18 8v3M8 12h8" />
	</svg>
);
const Diff = () => (
	<svg
		width={16}
		height={16}
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		strokeWidth={2}
	>
		<title>Diff</title>
		<path d="M6 3v12M6 15a3 3 0 003 3h6" />
		<circle cx={6} cy={18} r={2} />
		<circle cx={18} cy={6} r={2} />
		<path d="M18 8v10" />
	</svg>
);
const Ai = () => (
	<svg
		width={16}
		height={16}
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		strokeWidth={2}
	>
		<title>IA</title>
		<path d="M12 3l2 5 5 2-5 2-2 5-2-5-5-2 5-2z" />
	</svg>
);
const Export = () => (
	<svg
		width={16}
		height={16}
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		strokeWidth={2}
	>
		<title>Exporter</title>
		<path d="M12 3v12m0 0l-4-4m4 4l4-4M5 19h14" />
	</svg>
);
const Theme = () => (
	<svg
		width={16}
		height={16}
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		strokeWidth={2}
	>
		<title>Thème</title>
		<path d="M20 14A8 8 0 0110 4a8 8 0 1010 10z" />
	</svg>
);

interface Props {
	readonly onAutoLayout?: () => void;
}

/** Toolbar horizontale du canvas Schéma — flottante en bas-centre. */
export function CanvasToolbar({ onAutoLayout }: Props) {
	const [tool, setTool] = useState<Tool>("select");
	return (
		<FloatingPanel position="bottom-center" offset={{ x: 0, y: 16 }} p={0}>
			<Toolbar orientation="horizontal" aria-label="Canvas actions">
				<ToolbarButton
					label="Sélection (V)"
					active={tool === "select"}
					onClick={() => setTool("select")}
				>
					<Cursor />
				</ToolbarButton>
				<ToolbarButton
					label="Créer un frame (F)"
					active={tool === "frame"}
					onClick={() => {
						setTool("frame");
						notImplemented("Création de frame");
					}}
				>
					<Frame />
				</ToolbarButton>
				<ToolbarButton
					label="Lasso multi-sélection"
					active={tool === "lasso"}
					onClick={() => {
						setTool("lasso");
						notImplemented("Lasso");
					}}
				>
					<Lasso />
				</ToolbarButton>
				<ToolbarButton
					label="Annoter (bientôt)"
					active={tool === "comment"}
					onClick={() => {
						setTool("comment");
						notImplemented("Annotations");
					}}
				>
					<Comment />
				</ToolbarButton>
				<Toolbar.Divider orientation="horizontal" />
				<ToolbarButton
					label="Relayoute auto"
					onClick={() => {
						if (onAutoLayout) onAutoLayout();
						else notImplemented("Relayoute auto");
					}}
				>
					<AutoLayout />
				</ToolbarButton>
				<ToolbarButton
					label="Diff schémas (bientôt)"
					statusDot="warning"
					onClick={() => notImplemented("Diff schémas")}
				>
					<Diff />
				</ToolbarButton>
				<ToolbarButton
					label="IA (bientôt)"
					statusDot="warning"
					onClick={() => notImplemented("IA")}
				>
					<Ai />
				</ToolbarButton>
				<Toolbar.Divider orientation="horizontal" />
				<ToolbarButton
					label="Exporter"
					onClick={() => notImplemented("Export")}
				>
					<Export />
				</ToolbarButton>
				<ToolbarButton label="Thème" onClick={() => notImplemented("Thème")}>
					<Theme />
				</ToolbarButton>
			</Toolbar>
		</FloatingPanel>
	);
}
