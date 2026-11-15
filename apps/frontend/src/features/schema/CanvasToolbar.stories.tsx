import { useState } from "react";
import { type CanvasTool, CanvasToolbar } from "./CanvasToolbar";

export default {
	title: "App/Canvas/CanvasToolbar",
	component: CanvasToolbar,
	parameters: { layout: "fullscreen" }
};

function Demo({ inference }: { readonly inference: boolean }) {
	const [tool, setTool] = useState<CanvasTool>("select");
	const [inferenceActive, setInferenceActive] = useState(false);
	return (
		<div
			style={{
				position: "relative",
				height: 200,
				background: "var(--sqlnest-canvas-bg)"
			}}
		>
			<CanvasToolbar
				activeTool={tool}
				onSelectTool={setTool}
				onAutoLayout={() => {}}
				onCreateConsole={() => {}}
				{...(inference
					? {
							onToggleInference: () => setInferenceActive((v) => !v),
							inferenceActive
						}
					: {})}
			/>
		</div>
	);
}

/** Base avec clés étrangères : rien à inférer, le bouton n'est pas rendu. */
export const BaseAvecRelations = { render: () => <Demo inference={false} /> };

/** Base sans clés étrangères : le bouton d'inférence apparaît. */
export const BaseSansRelations = { render: () => <Demo inference /> };
