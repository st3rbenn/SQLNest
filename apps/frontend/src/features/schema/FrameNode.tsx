import { FrameBadge } from "@sqlnest/design-system";
import { type Node, NodeResizer, type NodeProps } from "@xyflow/react";
import type { Frame, FrameRect } from "./frames";

export interface FrameNodeData {
	readonly frame: Frame;
	/** Callback appelé quand l'utilisateur redimensionne le frame via les
	 * handles (fourni par SchemaCanvas — closure sur `useFrames.setFrameRect`). */
	readonly onResizeEnd?: (rect: FrameRect) => void;
	readonly [key: string]: unknown;
}

export type FrameNodeType = Node<FrameNodeData, "frame">;

const MIN_FRAME_WIDTH = 200;
const MIN_FRAME_HEIGHT = 120;

/**
 * Frame de groupage rendu **derrière** les nœuds table (zIndex négatif).
 * Le corps du frame ignore les pointer-events (pour que le clic sur une
 * table passe à travers), mais son **label** (le `FrameBadge` en coin)
 * ET les **handles de resize** (fournis par `NodeResizer`) les acceptent.
 */
export function FrameNode({
	data,
	width,
	height,
	selected,
	positionAbsoluteX,
	positionAbsoluteY
}: NodeProps<FrameNodeType>) {
	const { frame, onResizeEnd } = data;
	return (
		<>
			{/* Handles de resize (visibles quand le frame est sélectionné).
			 * `pointerEvents` passe automatiquement à `auto` via les propres
			 * styles de `NodeResizer` — nos overrides ci-dessous n'atteignent
			 * pas ces handles. `onResizeEnd` persiste le nouveau rect. */}
			<NodeResizer
				isVisible={selected === true}
				minWidth={MIN_FRAME_WIDTH}
				minHeight={MIN_FRAME_HEIGHT}
				lineStyle={{
					borderColor: `hsl(${frame.hue}, 55%, 55%)`,
					borderWidth: 2
				}}
				handleStyle={{
					width: 10,
					height: 10,
					borderRadius: 3,
					background: "#fff",
					borderColor: `hsl(${frame.hue}, 55%, 55%)`,
					borderWidth: 2
				}}
				onResizeEnd={(_, params) => {
					onResizeEnd?.({
						x: params.x ?? positionAbsoluteX,
						y: params.y ?? positionAbsoluteY,
						width: params.width,
						height: params.height
					});
				}}
			/>
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
		</>
	);
}
