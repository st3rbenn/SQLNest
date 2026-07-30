import { FrameBadge } from "@sqlnest/design-system";
import type { Node, NodeProps } from "@xyflow/react";
import type { Frame } from "./frames";

export interface FrameNodeData {
	readonly frame: Frame;
	readonly [key: string]: unknown;
}

export type FrameNodeType = Node<FrameNodeData, "frame">;

/**
 * Frame de groupage rendu **derrière** les nœuds table (zIndex négatif).
 * Le corps du frame ignore les pointer-events (pour que le clic sur une
 * table passe à travers), mais son **label** (le `FrameBadge` en coin) les
 * accepte — c'est la poignée de drag/selection du frame.
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
			<div
				style={{
					position: "absolute",
					top: -13,
					left: 12,
					pointerEvents: "auto",
					cursor: "grab"
				}}
			>
				<FrameBadge
					hue={frame.hue}
					label={frame.label}
					count={frame.collections.length}
				/>
			</div>
		</div>
	);
}
