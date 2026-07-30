import { FrameBadge } from "@sqlnest/design-system";
import type { Node, NodeProps } from "@xyflow/react";
import type { Frame } from "./frames";

export interface FrameNodeData {
	readonly frame: Frame;
	readonly [key: string]: unknown;
}

export type FrameNodeType = Node<FrameNodeData, "frame">;

/**
 * Frame de groupage rendu **derrière** les nœuds table (zIndex négatif,
 * pointer-events désactivés). Le badge de label flotte au coin supérieur.
 */
export function FrameNode({ data, width, height }: NodeProps<FrameNodeType>) {
	const { frame } = data;
	return (
		<div
			style={{
				width,
				height,
				borderRadius: 14,
				border: `2px solid hsl(${frame.hue}, 55%, 60%)`,
				background: `hsla(${frame.hue}, 60%, 90%, 0.35)`,
				boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.6)",
				position: "relative",
				pointerEvents: "none"
			}}
		>
			<div style={{ position: "absolute", top: -13, left: 12 }}>
				<FrameBadge
					hue={frame.hue}
					label={frame.label}
					count={frame.collections.length}
				/>
			</div>
		</div>
	);
}
