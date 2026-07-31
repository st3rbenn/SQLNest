import { FrameBadge } from "@sqlnest/design-system";
import { type Node, NodeResizer, type NodeProps } from "@xyflow/react";
import { useState } from "react";
import type { Frame, FrameRect } from "./frames";

export interface FrameNodeData {
	readonly frame: Frame;
	/** Appelé PENDANT le drag de resize (chaque tick pointermove). Doit
	 * juste maj le rect — pas de reconciliation membership (le user est
	 * en train de bouger, les tables ne bougent pas encore). Sans ce
	 * handler, RF's NodeResizer ne redraw pas en direct (visuellement
	 * figé jusqu'au release). Fourni par SchemaCanvas — closure sur
	 * `framesApi.setFrameRect`. */
	readonly onResize?: (rect: FrameRect) => void;
	/** Appelé au release du resize. Rect final + reconciliation membership
	 * (tables tombées hors du nouveau rect → retirées). Fourni par
	 * SchemaCanvas — closure sur `handleFrameResize`. */
	readonly onResizeEnd?: (rect: FrameRect) => void;
	/** Callback appelé au commit d'un rename inline (Enter ou blur). Fourni
	 * par SchemaCanvas — closure sur `useFrames.renameFrame`. */
	readonly onRename?: (label: string) => void;
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
	const { frame, onResize, onResizeEnd, onRename } = data;

	// Rename inline : double-clic sur le badge → input, Enter/blur commit,
	// Escape cancel. Un `draft` local évite d'écrire dans le state parent
	// à chaque keystroke ; commit ne fire onRename que si le label a
	// vraiment changé (et n'est pas vide après trim).
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(frame.label);

	const startEdit = () => {
		setDraft(frame.label);
		setEditing(true);
	};
	const commit = () => {
		const trimmed = draft.trim();
		if (trimmed !== "" && trimmed !== frame.label) onRename?.(trimmed);
		setEditing(false);
	};
	const cancel = () => {
		setDraft(frame.label);
		setEditing(false);
	};

	return (
		<>
			{/* Handles de resize (visibles quand le frame est sélectionné).
			 * `pointerEvents` passe automatiquement à `auto` via les propres
			 * styles de `NodeResizer` — nos overrides ci-dessous n'atteignent
			 * pas ces handles. `onResizeEnd` persiste le nouveau rect. */}
			<NodeResizer
				isVisible
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
				onResize={(_, params) => {
					// Live update pendant le drag → le rect (et donc les dimensions
					// passées au node par computeFrameNodes) suit en temps réel.
					onResize?.({
						x: params.x ?? positionAbsoluteX,
						y: params.y ?? positionAbsoluteY,
						width: params.width,
						height: params.height
					});
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
					// Suit les dimensions React du node — mises à jour en direct
					// pendant le drag grâce au handler `onResize` (live setFrameRect
					// → re-render → nouvelles width/height dans les props).
					width,
					height,
					borderRadius: 14,
					border: `2px solid hsl(${frame.hue}, 55%, 60%)`,
					background: `hsla(${frame.hue}, 60%, 90%, 0.35)`,
					// Sélectionné → halo bleu autour, garde le style couleur du frame
					// intact. Sinon → ombre inset douce comme avant.
					boxShadow: selected
						? "0 0 0 3px rgba(37,99,235,0.45), inset 0 0 0 1px rgba(255,255,255,0.6)"
						: "inset 0 0 0 1px rgba(255,255,255,0.6)",
					transition: "box-shadow 120ms",
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
						cursor: editing ? "text" : "grab"
					}}
					onDoubleClick={(e) => {
						// Empêche RF `onNodeDoubleClick` de faire son travail
						// (focusAndZoom sur les tables — ici on rename).
						e.stopPropagation();
						startEdit();
					}}
				>
					{editing ? (
						<input
							// biome-ignore lint/a11y/noAutofocus: pattern classique inline-edit — le focus est déclenché par un geste user.
							autoFocus
							value={draft}
							onChange={(e) => setDraft(e.currentTarget.value)}
							onBlur={commit}
							onKeyDown={(e) => {
								// Enter commit, Escape cancel. Toujours stop-prop pour
								// que le raccourci global "F" (créer un frame) ne se
								// déclenche pas depuis l'input.
								e.stopPropagation();
								if (e.key === "Enter") {
									e.preventDefault();
									commit();
								} else if (e.key === "Escape") {
									e.preventDefault();
									cancel();
								}
							}}
							onFocus={(e) => e.currentTarget.select()}
							onMouseDown={(e) => e.stopPropagation()}
							onClick={(e) => e.stopPropagation()}
							style={{
								background: `hsl(${frame.hue}, 55%, 45%)`,
								color: "#fff",
								border: "none",
								padding: "3px 10px",
								borderRadius: 999,
								fontSize: 11,
								fontWeight: 700,
								outline: "none",
								minWidth: 90,
								maxWidth: 240,
								fontFamily: "inherit",
								letterSpacing: 0.2
							}}
							aria-label="Renommer le frame"
						/>
					) : (
						<FrameBadge
							hue={frame.hue}
							label={frame.label}
							count={frame.collections.length}
						/>
					)}
				</div>
			</div>
		</>
	);
}
