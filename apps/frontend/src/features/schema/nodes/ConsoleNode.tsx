/**
 * ConsoleNode — la console SNQL vit dans le canvas comme un node RF
 * custom. Le corps est le même `ConsoleShellInner` que celui de la
 * route `/query` fullscreen (header/tabs/éditeur/résultats/split-resize
 * inchangés) ; seul le châssis change.
 *
 * ─── Interactions ─────────────────────────────────────────────────────
 * - Drag : le user drag depuis le **cadre** autour du contenu (padding
 *   22 px top = bande de drag visible avec 4 dots, cursor "grab"). Le
 *   contenu porte `className="nodrag nowheel"` pour ne pas déclencher
 *   le drag depuis l'éditeur, ni le zoom canvas depuis la molette dans
 *   les résultats.
 * - Resize : `NodeResizer` natif RF (4 côtés + 4 coins), visible au
 *   hover (même pattern que TableNode), lignes/handles bleus accent.
 * - Focus (single-click) : `focusAndZoom` — le canvas zoom modéré sur
 *   ce node (comme pour une table).
 * - Fullscreen (double-click ou bouton ⤢) : SchemaCanvas override la
 *   geom du node à `innerWidth × innerHeight` position `(0, 0)` +
 *   viewport à zoom 1. Le node lui-même passe en mode chrome-less (pas
 *   de padding drag / border / shadow / NodeResizer) → visuellement
 *   une page classique fullscreen. Le CSS fade masque les autres nodes/
 *   overlays. Le shell inner N'EST PAS remonté — même instance, state
 *   useRunQuery et tabs préservés au switch de mode.
 * - Delete : bouton `×` dans le header.
 *
 * ─── Isolation multi-instances ────────────────────────────────────────
 * `tabsScopeSuffix={id}` : chaque node a ses propres tabs SNQL. Pas de
 * partage entre 2 nodes console sur la même connexion.
 */

import { Tooltip } from "@mantine/core";
import {
	IconArrowsMaximize,
	IconArrowsMinimize,
	IconX
} from "@tabler/icons-react";
import { type Node, type NodeProps, NodeResizer } from "@xyflow/react";
import type { CSSProperties } from "react";
import { createPortal } from "react-dom";
import { ConsoleShellInner } from "../../query/ConsoleShellInner";
import {
	CONSOLE_NODE_MIN_HEIGHT,
	CONSOLE_NODE_MIN_WIDTH
} from "../canvas/useConsoleNodes";

export interface ConsoleNodeData {
	readonly teamSlug: string;
	readonly connId: string;
	readonly isFocused: boolean;
	readonly onResizeEnd?: (
		id: string,
		size: { width: number; height: number; x: number; y: number }
	) => void;
	readonly onEnterFocus?: (id: string) => void;
	readonly onExitFocus?: () => void;
	readonly onDelete?: (id: string) => void;
	readonly [key: string]: unknown;
}

export type ConsoleNodeType = Node<ConsoleNodeData, "console">;

const outerNodeStyle: CSSProperties = {
	width: "100%",
	height: "100%",
	// TOP 22px = bande de drag visible, LEFT/RIGHT/BOTTOM 6px = accès aux
	// handles NodeResizer sans écraser le contenu. Le user drag depuis la
	// bande supérieure — le contenu porte `nodrag` donc pas de conflit
	// avec l'éditeur / tabs / boutons du header.
	padding: "22px 6px 6px 6px",
	boxSizing: "border-box",
	background: "var(--sqlnest-surface)",
	border: "1px solid var(--sqlnest-border)",
	borderRadius: 12,
	// `--sqlnest-shadow-floating` fallback si le token n'existe pas — la
	// valeur en dur reste discrète sur le fond `#1E1E1E`.
	boxShadow: "var(--sqlnest-shadow-floating, 0 8px 24px rgba(0,0,0,0.35))",
	overflow: "hidden",
	display: "flex",
	flexDirection: "column",
	cursor: "grab",
	// 4 points centrés en haut de la bande drag pour signaler visuellement
	// la zone. ViewBox width 27 = 4 cercles cx=3/10/17/24 r=1.5 espacés
	// de 7 px avec 3 px de marge de chaque côté — sans ça le dernier
	// cercle (cx=23, r=1.5) déborderait sur x=24.5 et se ferait clipper.
	backgroundImage:
		"url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='27' height='4' viewBox='0 0 27 4'><g fill='%23ffffff' fill-opacity='0.28'><circle cx='3' cy='2' r='1.5'/><circle cx='10' cy='2' r='1.5'/><circle cx='17' cy='2' r='1.5'/><circle cx='24' cy='2' r='1.5'/></g></svg>\")",
	backgroundRepeat: "no-repeat",
	backgroundPosition: "center 9px"
};

// Overlay fullscreen — le shell est rendu ici via React Portal quand
// isFocused. Hors du transform React Flow → texte natif (pas de scale
// zoom), events ne remontent pas au canvas (pas de pan/zoom accidentel
// depuis un click dans le contenu).
const overlayStyle: CSSProperties = {
	position: "fixed",
	inset: 0,
	zIndex: 1000,
	background: "var(--sqlnest-canvas-bg)",
	display: "flex",
	flexDirection: "column"
};

const innerHolderStyle: CSSProperties = {
	flex: 1,
	minHeight: 0,
	minWidth: 0,
	borderRadius: 8,
	overflow: "hidden"
};


const focusButtonStyle: CSSProperties = {
	display: "inline-flex",
	alignItems: "center",
	justifyContent: "center",
	width: 24,
	height: 24,
	borderRadius: 4,
	background: "transparent",
	border: "1px solid var(--sqlnest-border-subtle)",
	color: "var(--sqlnest-text-secondary)",
	cursor: "pointer",
	padding: 0
};

const tooltipStyles = {
	tooltip: { fontSize: 11, padding: "4px 8px", borderRadius: 6 }
} as const;

export function ConsoleNode({
	id,
	data
}: NodeProps<ConsoleNodeType>): React.ReactNode {
	const {
		teamSlug,
		connId,
		isFocused,
		onResizeEnd,
		onEnterFocus,
		onExitFocus,
		onDelete
	} = data;

	// En fullscreen : le shell est rendu via React Portal vers document.body
	// → hors du transform React Flow (pas de scale zoom qui shrink le
	// contenu, pas de click qui remonte au canvas pour trigger un pan/zoom).
	// Note : le shell est UNMOUNT côté node quand on entre en fullscreen et
	// REMOUNT au retour → le state useRunQuery (mutation en cours) est
	// perdu au switch. Les tabs / historique / geoms persistent car
	// localStorage. Trade-off accepté pour éviter le RF viewport scale.
	if (isFocused) {
		return typeof document !== "undefined"
			? createPortal(
					<div style={overlayStyle}>
						<ConsoleShellInner
							teamSlug={teamSlug}
							connId={connId}
							variant="node"
							tabsScopeSuffix={id}
							extraLeftActions={
								<Tooltip
									label="Sortir du fullscreen (Esc)"
									openDelay={400}
									styles={tooltipStyles}
									withArrow
									arrowSize={4}
								>
									<button
										type="button"
										style={focusButtonStyle}
										aria-label="Sortir du fullscreen"
										onClick={(e) => {
											e.stopPropagation();
											onExitFocus?.();
										}}
									>
										<IconArrowsMinimize size={13} stroke={2} />
									</button>
								</Tooltip>
							}
						/>
					</div>,
					document.body
				)
			: null;
	}

	return (
		<>
			<NodeResizer
				isVisible
				minWidth={CONSOLE_NODE_MIN_WIDTH}
				minHeight={CONSOLE_NODE_MIN_HEIGHT}
				lineStyle={{
					borderColor: "var(--sqlnest-accent)",
					borderWidth: 1
				}}
				handleStyle={{
					width: 10,
					height: 10,
					borderRadius: 3,
					background: "var(--sqlnest-surface)",
					borderColor: "var(--sqlnest-accent)",
					borderWidth: 2
				}}
				onResizeEnd={(_, params) => {
					// Passe aussi x/y — RF déplace l'origine du node quand le
					// user drag depuis un handle top ou left (pour garder
					// l'opposé fixe). Sans persister x/y, le refresh remettrait
					// le node à l'ancienne origine → il semblerait grossir
					// uniquement vers bas-droite (bug frame).
					onResizeEnd?.(id, {
						width: params.width,
						height: params.height,
						x: params.x ?? 0,
						y: params.y ?? 0
					});
				}}
			/>
			<div style={outerNodeStyle}>
				<div className="nodrag nowheel" style={innerHolderStyle}>
					<ConsoleShellInner
						teamSlug={teamSlug}
						connId={connId}
						variant="node"
						tabsScopeSuffix={id}
						extraLeftActions={
							<>
								<Tooltip
									label="Passer en fullscreen"
									openDelay={400}
									styles={tooltipStyles}
									withArrow
									arrowSize={4}
								>
									<button
										type="button"
										style={focusButtonStyle}
										aria-label="Passer en fullscreen"
										onClick={(e) => {
											e.stopPropagation();
											onEnterFocus?.(id);
										}}
									>
										<IconArrowsMaximize size={13} stroke={2} />
									</button>
								</Tooltip>
								<Tooltip
									label="Fermer cette console"
									openDelay={400}
									styles={tooltipStyles}
									withArrow
									arrowSize={4}
								>
									<button
										type="button"
										style={focusButtonStyle}
										aria-label="Fermer cette console"
										onClick={(e) => {
											e.stopPropagation();
											onDelete?.(id);
										}}
									>
										<IconX size={13} stroke={2} />
									</button>
								</Tooltip>
							</>
						}
					/>
				</div>
			</div>
		</>
	);
}
