import { FrameBadge } from "@sqlnest/design-system";
import {
	type Node,
	type NodeProps,
	NodeResizer,
	useStore
} from "@xyflow/react";
import { useState } from "react";
import type { Frame, FrameRect } from "./frames";

export interface FrameNodeData {
	readonly frame: Frame;
	/** Appelé au release du resize avec `(frame.key, rect)`. Rect final +
	 * reconciliation membership (tables tombées hors du nouveau rect →
	 * retirées). Fourni par SchemaCanvas — `handleFrameResize` stable via
	 * useCallback. Le suivi live des dimensions/position pendant le drag
	 * est géré côté SchemaCanvas via l'interception des changes RF (voir
	 * `handleNodesChange`).
	 *
	 * NOTE (C.14) : la clé est passée en 1er arg APPLIQUÉ CÔTÉ FrameNode
	 * (avec `data.frame.key`) plutôt que via une closure inline
	 * `(r) => handler(key, r)` dans computeFrameNodes. Cela garde `data`
	 * stable entre renders → RF n'invalide plus le NodeResizer en cours
	 * de drag (les axes sautaient sinon). */
	readonly onResizeEnd?: (key: string, rect: FrameRect) => void;
	/** Callback appelé au commit d'un rename inline (Enter ou blur). Signature
	 * `(key, label)` — stable via useCallback côté SchemaCanvas. */
	readonly onRename?: (key: string, label: string) => void;
	/** Callback appelé au right-click sur le badge — `(key)`. */
	readonly onDelete?: (key: string) => void;
	/** Callback appelé au clic gauche sur le badge — `(key)`, ouvre la vue
	 * FrameDetails dans le drawer gauche (liste des tables du frame). */
	readonly onFocus?: (key: string) => void;
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
 *
 * Non-sélectionnable (`selectable: false` côté SchemaCanvas). Les gestes
 * user sont : drag = déplacer, drag d'un handle = resize, double-clic
 * badge = renommer, right-click badge = supprimer.
 */
export function FrameNode({
	data,
	width,
	height,
	positionAbsoluteX,
	positionAbsoluteY
}: NodeProps<FrameNodeType>) {
	const { frame, onResizeEnd, onRename, onDelete, onFocus } = data;

	// Rename inline : double-clic sur le badge → input, Enter/blur commit,
	// Escape cancel. Un `draft` local évite d'écrire dans le state parent
	// à chaque keystroke ; commit ne fire onRename que si le label a
	// vraiment changé (et n'est pas vide après trim).
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(frame.label);

	// Zoom-invariance du badge : il doit garder une taille lisible EN
	// PIXELS ÉCRAN quelle que soit la profondeur de zoom. `useStore` avec
	// un sélecteur scalaire ne re-render que si la valeur change → ok.
	// Cappé à [0.5, 2.5] pour éviter les extrêmes.
	const zoom = useStore((s) => s.transform[2]);
	const badgeScale = Math.max(0.5, Math.min(2.5, 1 / zoom));

	const startEdit = () => {
		setDraft(frame.label);
		setEditing(true);
	};
	const commit = () => {
		const trimmed = draft.trim();
		if (trimmed !== "" && trimmed !== frame.label) {
			onRename?.(frame.key, trimmed);
		}
		setEditing(false);
	};
	const cancel = () => {
		setDraft(frame.label);
		setEditing(false);
	};

	return (
		<>
			{/* Handles de resize toujours visibles (frame non-sélectionnable).
			 * Le tracking live des dimensions et position pendant le drag est
			 * délégué à `SchemaCanvas.handleNodesChange` qui intercepte les
			 * `dimensions` / `position` NodeChange émis par NodeResizer et les
			 * route vers `framesApi.setFrameRect`. `onResizeEnd` sert juste au
			 * signal de fin → reconciliation membership. */}
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
					// `--sqlnest-surface` — un blanc pur ferait « oeuf sur canvas
					// noir » et brûlerait la teinte du frame.
					background: "var(--sqlnest-surface)",
					borderColor: `hsl(${frame.hue}, 55%, 55%)`,
					borderWidth: 2
				}}
				onResizeEnd={(_, params) => {
					onResizeEnd?.(frame.key, {
						x: params.x ?? positionAbsoluteX,
						y: params.y ?? positionAbsoluteY,
						width: params.width,
						height: params.height
					});
				}}
			/>
			<div
				style={{
					// Suit les dimensions React (width/height du node), mises à
					// jour en direct par `SchemaCanvas.handleNodesChange` qui
					// route les `dimensions` NodeChange RF vers setFrameRect.
					// Pas de bordure propre — c'est `NodeResizer.lineStyle` qui
					// dessine les 4 côtés (sinon double bordure avec halo).
					width,
					height,
					borderRadius: 14,
					// Pastel translucide sombre-adapté : sur bg #1E1E1E, un tint
					// L=90 ferait tache. On descend à L=45 (nuance moyenne de
					// la hue) et on baisse l'alpha à 12 % — teinte discernable
					// des tables du frame sans écraser leur shell.
					background: `hsla(${frame.hue}, 60%, 45%, 0.12)`,
					position: "relative",
					pointerEvents: "none"
				}}
			>
				{/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: badge cliquable dans un node RF — pas d'équivalent clavier pour un click sur un node canvas. */}
				{/* biome-ignore lint/a11y/useKeyWithClickEvents: idem */}
				{/* biome-ignore lint/a11y/noStaticElementInteractions: idem */}
				<div
					style={{
						position: "absolute",
						top: -13,
						left: 12,
						pointerEvents: "auto",
						cursor: editing ? "text" : "grab",
						// Ancre au coin haut-gauche du frame, puis compense le
						// zoom RF — le badge garde sa taille écran constante.
						transform: `scale(${badgeScale})`,
						transformOrigin: "0 100%"
					}}
					onClick={(e) => {
						// Clic gauche sur le badge → ouvre FrameDetails (liste des
						// tables du frame) dans le drawer gauche. Stop-prop pour
						// éviter que RF ait à re-router — évite aussi les conflits
						// avec le drag du frame déclenché par un mousedown sur le
						// wrapper RF quand on ne bouge pas la souris (tiny threshold).
						e.stopPropagation();
						onFocus?.(frame.key);
					}}
					onDoubleClick={(e) => {
						// Empêche RF `onNodeDoubleClick` de faire son travail
						// (focusAndZoom sur les tables — ici on rename).
						e.stopPropagation();
						startEdit();
					}}
					onContextMenu={(e) => {
						// Right-click sur le badge → supprime le frame. Empêche
						// le menu par défaut du navigateur ET RF's onNodeContextMenu.
						e.preventDefault();
						e.stopPropagation();
						onDelete?.(frame.key);
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
								background: `hsl(${frame.hue}, 55%, 35%)`,
								color: "var(--sqlnest-text-primary)",
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
