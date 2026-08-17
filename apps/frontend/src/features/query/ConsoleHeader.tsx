/**
 * Top bar de la console SNQL fullscreen — pattern IDE moderne : breadcrumb
 * back + titre "Console SNQL" + tabs draggables SUR LA MÊME LIGNE, puis
 * actions à droite (Historique, Détacher, Exécuter primary).
 *
 * Aligné sur le mockup 2a : tabs intégrées dans le header (pas de barre
 * séparée). Chaque tab affiche : dot coloré (bleu si active + résultat OK,
 * gris sinon) · nom · count badge (rowCount du dernier run) · ×.
 */

import { Button, useModKeyLabel } from "@sqlnest/design-system";
import { ActionIcon, Menu, Tooltip } from "@mantine/core";
import {
	closestCenter,
	DndContext,
	type DragEndEvent,
	PointerSensor,
	useSensor,
	useSensors
} from "@dnd-kit/core";
import {
	horizontalListSortingStrategy,
	SortableContext,
	useSortable
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
	IconArrowLeft,
	IconExternalLink,
	IconHistory,
	IconIndentIncrease,
	IconPlus,
	IconTerminal2,
	IconX
} from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { type CSSProperties, useEffect, useRef, useState } from "react";
import type { ConsoleTab } from "./useConsoleTabs";

const headerStyle: CSSProperties = {
	display: "flex",
	alignItems: "center",
	gap: 12,
	padding: "0 12px",
	height: 44,
	background: "var(--sqlnest-surface)",
	borderBottom: "1px solid var(--sqlnest-border)",
	flexShrink: 0
};

const leftGroupStyle: CSSProperties = {
	display: "flex",
	alignItems: "center",
	gap: 10,
	flexShrink: 0
};

const backLinkStyle: CSSProperties = {
	display: "inline-flex",
	alignItems: "center",
	gap: 6,
	fontSize: 12,
	color: "var(--sqlnest-text-secondary)",
	textDecoration: "none",
	padding: "4px 8px",
	borderRadius: 4
};

const closeButtonStyle: CSSProperties = {
	display: "inline-flex",
	alignItems: "center",
	gap: 6,
	fontSize: 12,
	color: "var(--sqlnest-text-secondary)",
	background: "transparent",
	border: "none",
	cursor: "pointer",
	padding: "4px 8px",
	borderRadius: 4
};

const separatorStyle: CSSProperties = {
	width: 1,
	alignSelf: "center",
	height: 18,
	background: "var(--sqlnest-border)"
};

const titleGroupStyle: CSSProperties = {
	display: "inline-flex",
	alignItems: "center",
	gap: 6,
	color: "var(--sqlnest-text-primary)",
	fontSize: 12.5,
	fontWeight: 600,
	flexShrink: 0
};

const connChipStyle: CSSProperties = {
	display: "inline-flex",
	alignItems: "center",
	fontSize: 11,
	fontWeight: 500,
	color: "var(--sqlnest-text-secondary)",
	background: "var(--sqlnest-surface-hover)",
	border: "1px solid var(--sqlnest-border-subtle)",
	borderRadius: 4,
	padding: "1px 7px",
	overflow: "hidden",
	textOverflow: "ellipsis",
	whiteSpace: "nowrap",
	maxWidth: 180
};

const tabsRailStyle: CSSProperties = {
	display: "flex",
	alignItems: "flex-end",
	gap: 0,
	flex: 1,
	minWidth: 0,
	height: "100%",
	overflowX: "auto",
	overflowY: "hidden",
	scrollbarWidth: "none"
};

// Style VS Code : rectangles carrés (pas de rounded), top border accent
// sur la tab active, bg align sur l'éditeur (canvas-bg), inactive =
// transparent + hover surface-hover.
const tabBaseStyle: CSSProperties = {
	display: "inline-flex",
	alignItems: "center",
	gap: 6,
	padding: "0 8px 0 12px",
	fontSize: 12,
	color: "var(--sqlnest-text-secondary)",
	background: "transparent",
	border: "none",
	borderTop: "2px solid transparent",
	borderRadius: 0,
	cursor: "pointer",
	whiteSpace: "nowrap",
	height: 34,
	position: "relative",
	transition: "background-color 120ms ease, color 120ms ease"
};

const tabActiveStyle: CSSProperties = {
	color: "var(--sqlnest-text-primary)",
	background: "var(--sqlnest-canvas-bg)",
	borderTop: "2px solid var(--sqlnest-accent)",
	// Déborde de 1px sur la border-bottom du header pour "avaler" la
	// ligne de séparation (canvas-bg peint par-dessus).
	marginBottom: -1
};

const tabCountStyle: CSSProperties = {
	fontSize: 10,
	fontWeight: 500,
	color: "var(--sqlnest-text-tertiary)",
	fontVariantNumeric: "tabular-nums"
};

const tabCloseStyle: CSSProperties = {
	display: "inline-flex",
	alignItems: "center",
	justifyContent: "center",
	width: 15,
	height: 15,
	borderRadius: 3,
	background: "transparent",
	border: "none",
	color: "var(--sqlnest-text-tertiary)",
	cursor: "pointer",
	padding: 0
};

const renameInputStyle: CSSProperties = {
	background: "var(--sqlnest-canvas-bg)",
	border: "1px solid var(--sqlnest-accent)",
	borderRadius: 4,
	color: "var(--sqlnest-text-primary)",
	fontSize: 12,
	padding: "1px 6px",
	outline: "none",
	width: 120
};

const rightGroupStyle: CSSProperties = {
	display: "flex",
	alignItems: "center",
	gap: 6,
	flexShrink: 0
};

const menuStyles = {
	dropdown: {
		background: "var(--sqlnest-surface)",
		border: "1px solid var(--sqlnest-border-subtle)",
		padding: 3
	},
	item: {
		fontSize: 11,
		color: "var(--sqlnest-text-primary)",
		padding: "5px 8px",
		borderRadius: 4,
		minHeight: 0
	}
} as const;

const outlineBtnStyle: CSSProperties = {
	display: "inline-flex",
	alignItems: "center",
	gap: 5,
	fontSize: 11,
	color: "var(--sqlnest-text-primary)",
	background: "var(--sqlnest-surface)",
	border: "1px solid var(--sqlnest-border)",
	borderRadius: 5,
	padding: "4px 8px",
	cursor: "pointer",
	minHeight: 26
};

export type ConsoleHeaderVariant = "route" | "node";

export interface ConsoleHeaderProps {
	readonly connectionName: string;
	readonly teamSlug: string;
	readonly connId: string;
	readonly isPopout: boolean;
	readonly canExecute: boolean;
	readonly canFormat: boolean;
	readonly isRunning: boolean;
	readonly onExecute: () => void;
	readonly onFormat: () => void;
	readonly onDetach: () => void;
	readonly history: readonly string[];
	readonly onHistorySelect: (source: string) => void;
	readonly onHistoryClear: () => void;
	readonly tabs: readonly ConsoleTab[];
	readonly activeTabId: string;
	readonly onSelectTab: (id: string) => void;
	readonly onCloseTab: (id: string) => void;
	readonly onNewTab: () => void;
	readonly onRenameTab: (id: string, name: string) => void;
	readonly onReorderTabs: (fromId: string, toId: string) => void;
	/** `"route"` (défaut) = shell fullscreen ; rend Back Canvas / Fermer +
	 * Détacher. `"node"` = console vit dans un node RF ; cache back/close
	 * (le user navigue via le canvas) et cache Détacher (pas de popout
	 * depuis un node). L'usage passe des actions node-spécifiques via
	 * `extraLeftActions` (ex : bouton focus / close du node). */
	readonly variant?: ConsoleHeaderVariant;
	/** Slot pour actions insérées à gauche du titre — utilisé en mode
	 * `"node"` pour le bouton Focus/Collapse. Ignoré si absent. */
	readonly extraLeftActions?: React.ReactNode;
}

export function ConsoleHeader({
	connectionName,
	teamSlug,
	connId,
	isPopout,
	canExecute,
	canFormat,
	isRunning,
	onExecute,
	onFormat,
	onDetach,
	history,
	onHistorySelect,
	onHistoryClear,
	tabs,
	activeTabId,
	onSelectTab,
	onCloseTab,
	onNewTab,
	onRenameTab,
	onReorderTabs,
	variant = "route",
	extraLeftActions
}: ConsoleHeaderProps): React.ReactNode {
	const modKey = useModKeyLabel();

	const sensors = useSensors(
		useSensor(PointerSensor, {
			activationConstraint: { distance: 5 }
		})
	);

	function handleDragEnd(e: DragEndEvent): void {
		const { active, over } = e;
		if (over === null || active.id === over.id) return;
		onReorderTabs(String(active.id), String(over.id));
	}

	return (
		<div style={headerStyle}>
			<div style={leftGroupStyle}>
				{variant === "route" ? (
					<>
						{isPopout ? (
							<button
								type="button"
								style={closeButtonStyle}
								className="sqlnest-header-cta"
								onClick={() => window.close()}
							>
								<IconX size={13} stroke={2} />
								Fermer
							</button>
						) : (
							<Link
								to="/team/$teamSlug/canvas/$connId"
								params={{ teamSlug, connId }}
								style={backLinkStyle}
								className="sqlnest-header-cta"
							>
								<IconArrowLeft size={13} stroke={2} />
								Canvas
							</Link>
						)}
						<div style={separatorStyle} />
					</>
				) : null}
				{extraLeftActions}
				<span style={titleGroupStyle}>
					<IconTerminal2 size={14} stroke={2} />
					<span>Console</span>
				</span>
				<span style={connChipStyle} title={connectionName}>
					{connectionName}
				</span>
			</div>

			<div style={tabsRailStyle}>
				<DndContext
					sensors={sensors}
					collisionDetection={closestCenter}
					onDragEnd={handleDragEnd}
				>
					<SortableContext
						items={tabs.map((t) => t.id)}
						strategy={horizontalListSortingStrategy}
					>
						{tabs.map((tab) => (
							<SortableTab
								key={tab.id}
								tab={tab}
								isActive={tab.id === activeTabId}
								onSelect={onSelectTab}
								onClose={onCloseTab}
								onRename={onRenameTab}
							/>
						))}
					</SortableContext>
				</DndContext>
				<button
					type="button"
					aria-label="Nouvelle query"
					style={{
						...tabCloseStyle,
						width: 28,
						height: 34,
						borderRadius: 0,
						marginLeft: 2,
						color: "var(--sqlnest-text-secondary)"
					}}
					onClick={onNewTab}
				>
					<IconPlus size={13} stroke={2} />
				</button>
			</div>

			<div style={rightGroupStyle}>
				<Menu
					shadow="md"
					width={440}
					position="bottom-end"
					withArrow={false}
					radius={8}
					styles={menuStyles}
					disabled={history.length === 0}
				>
					<Menu.Target>
						<Tooltip
							label="Historique des requêtes"
							openDelay={400}
							styles={{
								tooltip: { fontSize: 11, padding: "4px 8px", borderRadius: 6 }
							}}
							withArrow
							arrowSize={4}
						>
							<ActionIcon
								variant="subtle"
								color="gray"
								size={26}
								radius={5}
								disabled={history.length === 0}
								aria-label="Historique"
							>
								<IconHistory size={13} stroke={2} />
							</ActionIcon>
						</Tooltip>
					</Menu.Target>
					<Menu.Dropdown>
						{history.map((q) => (
							<Menu.Item
								key={q}
								onClick={() => onHistorySelect(q)}
								style={{
									fontFamily: "var(--mantine-font-family-monospace)",
									whiteSpace: "nowrap",
									overflow: "hidden",
									textOverflow: "ellipsis"
								}}
							>
								{q.length > 90 ? `${q.slice(0, 87)}…` : q}
							</Menu.Item>
						))}
						<Menu.Divider />
						<Menu.Item color="red" onClick={onHistoryClear}>
							Vider l'historique
						</Menu.Item>
					</Menu.Dropdown>
				</Menu>

				<Tooltip
					label={`Formater — ${modKey} ⇧ F`}
					openDelay={400}
					styles={{
						tooltip: { fontSize: 11, padding: "4px 8px", borderRadius: 6 }
					}}
					withArrow
					arrowSize={4}
				>
					<ActionIcon
						variant="subtle"
						color="gray"
						size={26}
						radius={5}
						disabled={!canFormat}
						aria-label="Formater la requête"
						onClick={onFormat}
					>
						<IconIndentIncrease size={13} stroke={2} />
					</ActionIcon>
				</Tooltip>

				{variant === "route" && !isPopout ? (
					<Tooltip
						label={`Détacher — ${modKey} ⇧ K`}
						openDelay={400}
						styles={{
							tooltip: { fontSize: 11, padding: "4px 8px", borderRadius: 6 }
						}}
						withArrow
						arrowSize={4}
					>
						<button
							type="button"
							style={outlineBtnStyle}
							className="sqlnest-header-cta"
							onClick={onDetach}
						>
							<IconExternalLink size={12} stroke={2} />
							Détacher
						</button>
					</Tooltip>
				) : null}

				<Tooltip
					label={`Exécuter — ${modKey} ↵`}
					openDelay={400}
					styles={{
						tooltip: { fontSize: 11, padding: "4px 8px", borderRadius: 6 }
					}}
					withArrow
					arrowSize={4}
				>
					<div>
						<Button
							size="xs"
							variant="primary"
							disabled={!canExecute}
							loading={isRunning}
							loadingLabel="…"
							onClick={onExecute}
						>
							Exécuter
						</Button>
					</div>
				</Tooltip>
			</div>
		</div>
	);
}

function SortableTab({
	tab,
	isActive,
	onSelect,
	onClose,
	onRename
}: {
	readonly tab: ConsoleTab;
	readonly isActive: boolean;
	readonly onSelect: (id: string) => void;
	readonly onClose: (id: string) => void;
	readonly onRename: (id: string, name: string) => void;
}): React.ReactNode {
	const {
		attributes,
		listeners,
		setNodeRef,
		transform,
		transition,
		isDragging
	} = useSortable({ id: tab.id });

	const [isRenaming, setIsRenaming] = useState(false);
	const [draftName, setDraftName] = useState(tab.name);
	const inputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		if (isRenaming) {
			inputRef.current?.focus();
			inputRef.current?.select();
		}
	}, [isRenaming]);

	const style: CSSProperties = {
		...tabBaseStyle,
		...(isActive ? tabActiveStyle : null),
		transform: CSS.Transform.toString(transform),
		transition,
		opacity: isDragging ? 0.6 : 1
	};

	function commitRename(): void {
		const trimmed = draftName.trim();
		if (trimmed !== "" && trimmed !== tab.name) {
			onRename(tab.id, trimmed);
		} else {
			setDraftName(tab.name);
		}
		setIsRenaming(false);
	}

	return (
		<button
			type="button"
			ref={setNodeRef}
			style={style}
			className="sqlnest-console-tab"
			onClick={() => onSelect(tab.id)}
			onDoubleClick={(e) => {
				e.stopPropagation();
				setDraftName(tab.name);
				setIsRenaming(true);
			}}
			{...attributes}
			{...listeners}
		>
			{isRenaming ? (
				<input
					ref={inputRef}
					value={draftName}
					onChange={(e) => setDraftName(e.currentTarget.value)}
					onBlur={commitRename}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							e.preventDefault();
							commitRename();
						} else if (e.key === "Escape") {
							setDraftName(tab.name);
							setIsRenaming(false);
						}
						e.stopPropagation();
					}}
					onClick={(e) => e.stopPropagation()}
					style={renameInputStyle}
				/>
			) : (
				<span>{tab.name}</span>
			)}
			{tab.lastResult ? (
				<span style={tabCountStyle}>{tab.lastResult.rowCount}</span>
			) : null}
			<span
				role="button"
				tabIndex={-1}
				aria-label={`Fermer ${tab.name}`}
				style={tabCloseStyle}
				className="sqlnest-console-tab-close"
				onPointerDown={(e) => e.stopPropagation()}
				onClick={(e) => {
					e.stopPropagation();
					onClose(tab.id);
				}}
			>
				<IconX size={11} stroke={2} />
			</span>
		</button>
	);
}
