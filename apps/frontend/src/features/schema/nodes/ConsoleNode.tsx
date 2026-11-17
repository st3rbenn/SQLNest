/**
 * ConsoleNode — la console SNQL vit dans le canvas comme un node
 * custom. Le corps est le même `ConsoleShellInner` que celui de la
 * route `/query` fullscreen (header/tabs/éditeur/résultats/split-resize
 * inchangés) ; seul le châssis change.
 *
 * ─── Interactions ─────────────────────────────────────────────────────
 * - Deux états. Au repos, la console est un frame : on la déplace en la
 *   glissant depuis n'importe où (en-tête, éditeur), l'éditeur est inerte.
 *   En édition (double-clic, ou console qu'on vient de créer), l'éditeur a
 *   le clavier et le frame est figé (`nodrag`, node non déplaçable) ; un
 *   clic hors de la console rend la main. Les onglets et le panneau de
 *   résultats restent `nodrag` dans les deux états : on y trie, on y
 *   sélectionne.
 * - La molette défile le contenu quand il a de quoi défiler sous le
 *   pointeur, sinon elle déplace le canvas (`useContentWheel`).
 * - Resize : `NodeResizer` du moteur (4 côtés + 4 coins), visible au
 *   hover (même pattern que TableNode), lignes/handles bleus accent.
 * - Clic : sélection seule, la vue ne bouge pas.
 * - Fullscreen (bouton ⤢) : SchemaCanvas override la
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
	Handle,
	type Node,
	type NodeProps,
	NodeResizer,
	Position
} from "@sqlnest/canvas";
import {
	IconArrowsMaximize,
	IconArrowsMinimize,
	IconChevronsUp,
	IconX
} from "@tabler/icons-react";
import { type CSSProperties, useContext, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { ConsoleShellInner } from "../../query/ConsoleShellInner";
import {
	CONSOLE_NODE_MIN_HEIGHT,
	CONSOLE_NODE_MIN_WIDTH
} from "../canvas/useConsoleNodes";
import { colorFor } from "../colors";
import { ConsoleLinksContext } from "../console-links/ConsoleLinksContext";
import {
	CONSOLE_RESULT_HANDLE,
	CONSOLE_TABLE_HANDLE
} from "../console-links/QueryLinkEdge";
import { useContentWheel } from "./contentWheel";

export interface ConsoleNodeData {
	readonly teamSlug: string;
	readonly connId: string;
	readonly isFocused: boolean;
	/** Éditeur actif et frame figé ; sinon la console se déplace comme un frame. */
	readonly isEditing: boolean;
	readonly onExitEdit?: (id: string) => void;
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
	// 6px de cadre : accès aux handles NodeResizer sans écraser le contenu.
	padding: 6,
	boxSizing: "border-box",
	background: "var(--sqlnest-surface)",
	border: "1px solid var(--sqlnest-border)",
	borderRadius: "var(--sqlnest-radius-12)",
	// `--sqlnest-shadow-floating` fallback si le token n'existe pas — la
	// valeur en dur reste discrète sur le fond `#1E1E1E`.
	boxShadow: "var(--sqlnest-shadow-floating, 0 8px 24px rgba(0,0,0,0.35))",
	overflow: "hidden",
	display: "flex",
	flexDirection: "column",
	cursor: "grab"
};

/** En édition : le frame est figé, un anneau accent le dit. */
const editingNodeStyle: CSSProperties = {
	...outerNodeStyle,
	border: "1px solid var(--sqlnest-accent)",
	boxShadow: "0 0 0 3px var(--sqlnest-accent-soft)",
	cursor: "default"
};

// Overlay fullscreen — le shell est rendu ici via React Portal quand
// isFocused. Hors du transform du viewport → texte natif (pas de scale
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
	borderRadius: "var(--sqlnest-radius-8)",
	overflow: "hidden"
};

const focusButtonStyle: CSSProperties = {
	display: "inline-flex",
	alignItems: "center",
	justifyContent: "center",
	width: 24,
	height: 24,
	borderRadius: "var(--sqlnest-radius-4)",
	background: "transparent",
	border: "1px solid var(--sqlnest-border-subtle)",
	color: "var(--sqlnest-text-secondary)",
	cursor: "pointer",
	padding: 0
};

/** Table de départ d'une console rattachée : c'est le titre de son en-tête. */
const rootTitleStyle: CSSProperties = {
	display: "inline-flex",
	alignItems: "center",
	gap: 8,
	color: "var(--sqlnest-text-primary)",
	fontSize: "var(--sqlnest-font-size-13)",
	fontWeight: 600,
	whiteSpace: "nowrap"
};

/** Contrôles de fenêtre d'une console rattachée : sans cadre, à droite. */
const plainButtonStyle: CSSProperties = {
	...focusButtonStyle,
	border: "1px solid transparent"
};

const dividerStyle: CSSProperties = {
	width: 1,
	height: 16,
	margin: "0 2px",
	background: "var(--sqlnest-border)"
};

const tooltipStyles = {
	tooltip: {
		fontSize: "var(--sqlnest-font-size-11)",
		padding: "4px 8px",
		borderRadius: "var(--sqlnest-radius-6)"
	}
} as const;

export function ConsoleNode({
	id,
	data
}: NodeProps<ConsoleNodeType>): React.ReactNode {
	const links = useContext(ConsoleLinksContext);
	const holderRef = useRef<HTMLDivElement | null>(null);
	useContentWheel(holderRef);
	const foldable = links?.attached.has(id) === true;
	const root = links?.rootOf.get(id);
	const {
		teamSlug,
		connId,
		isFocused,
		isEditing,
		onExitEdit,
		onResizeEnd,
		onEnterFocus,
		onExitFocus,
		onDelete
	} = data;

	// Un clic hors de la console termine l'édition. Les menus de la console
	// vivent dans un portail Mantine : ils en font partie.
	useEffect(() => {
		if (!isEditing) return;
		function onPointerDown(e: PointerEvent): void {
			const target = e.target;
			if (!(target instanceof Element)) return;
			if (holderRef.current?.contains(target)) return;
			if (target.closest("[data-portal]") !== null) return;
			onExitEdit?.(id);
		}
		document.addEventListener("pointerdown", onPointerDown, true);
		return () =>
			document.removeEventListener("pointerdown", onPointerDown, true);
	}, [isEditing, onExitEdit, id]);

	// En fullscreen : le shell est rendu via React Portal vers document.body
	// → hors du transform du viewport (pas de scale zoom qui shrink le
	// contenu, pas de click qui remonte au canvas pour trigger un pan/zoom).
	// Note : le shell est UNMOUNT côté node quand on entre en fullscreen et
	// REMOUNT au retour → le state useRunQuery (mutation en cours) est
	// perdu au switch. Les tabs / historique / geoms persistent car
	// localStorage. Trade-off accepté pour éviter le scale du viewport.
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

	const buttonStyle = root !== undefined ? plainButtonStyle : focusButtonStyle;
	const windowButtons = (
		<>
			{foldable ? (
				<Tooltip
					label="Replier"
					openDelay={400}
					styles={tooltipStyles}
					withArrow
					arrowSize={4}
				>
					<button
						type="button"
						style={buttonStyle}
						aria-label="Replier"
						onClick={(e) => {
							e.stopPropagation();
							links?.fold(id);
						}}
					>
						<IconChevronsUp size={13} stroke={2} />
					</button>
				</Tooltip>
			) : null}
			<Tooltip
				label="Passer en fullscreen"
				openDelay={400}
				styles={tooltipStyles}
				withArrow
				arrowSize={4}
			>
				<button
					type="button"
					style={buttonStyle}
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
					style={buttonStyle}
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
	);

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
					borderRadius: "var(--sqlnest-radius-4)",
					background: "var(--sqlnest-surface)",
					borderColor: "var(--sqlnest-accent)",
					borderWidth: 2
				}}
				onResizeEnd={(_, params) => {
					// Passe aussi x/y — le resize déplace l'origine du node quand le
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
			{/* Points d'ancrage des liens vers la table de départ et vers le
			    frame de résultat. */}
			<Handle
				id={CONSOLE_TABLE_HANDLE}
				type="target"
				position={Position.Left}
				isConnectable={false}
				style={{ opacity: 0, border: "none" }}
			/>
			<Handle
				id={CONSOLE_RESULT_HANDLE}
				type="source"
				position={Position.Bottom}
				isConnectable={false}
				style={{ opacity: 0, border: "none" }}
			/>
			<div style={isEditing ? editingNodeStyle : outerNodeStyle}>
				<div
					ref={holderRef}
					className={isEditing ? "nodrag" : undefined}
					style={innerHolderStyle}
				>
					<ConsoleShellInner
						teamSlug={teamSlug}
						connId={connId}
						variant="node"
						tabsScopeSuffix={id}
						// Rattachée à une table : ses lignes sortent dans un frame,
						// et l'en-tête se réduit à la table, aux actions de requête
						// et aux contrôles de fenêtre.
						resultsOutside={foldable}
						compactHeader={foldable}
						editing={isEditing}
						extraLeftActions={
							root !== undefined ? (
								<span style={rootTitleStyle}>
									<span
										style={{
											width: 8,
											height: 8,
											borderRadius: "var(--sqlnest-radius-2)",
											background: colorFor(root).border
										}}
									/>
									{root}
								</span>
							) : (
								windowButtons
							)
						}
						extraRightActions={
							root !== undefined ? (
								<>
									<span style={dividerStyle} />
									{windowButtons}
								</>
							) : undefined
						}
					/>
				</div>
			</div>
		</>
	);
}
