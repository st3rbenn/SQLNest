/**
 * Tab bar horizontale de la console — draggable via @dnd-kit, rename
 * inline sur double-click, badge row count du dernier run, bouton `+`
 * pour ajouter un nouveau tab.
 *
 * Design aligné sur les tokens dark : tab actif = bg elevated + border-
 * top accent, inactif = transparent + text secondary, hover surface-
 * hover. Kept custom (pas Mantine Tabs) pour density + drag control.
 */

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
import { ToolbarButton } from "@sqlnest/design-system";
import { IconPlus, IconX } from "@tabler/icons-react";
import type { CSSProperties, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import type { ConsoleTab } from "./useConsoleTabs";

const barStyle: CSSProperties = {
	display: "flex",
	alignItems: "center",
	gap: 2,
	background: "var(--sqlnest-surface)",
	borderBottom: "1px solid var(--sqlnest-border)",
	padding: "0 8px",
	minHeight: 36,
	overflowX: "auto",
	overflowY: "hidden"
};

const scrollingListStyle: CSSProperties = {
	display: "flex",
	alignItems: "stretch",
	gap: 2,
	flex: 1,
	minWidth: 0
};

const tabBaseStyle: CSSProperties = {
	display: "inline-flex",
	alignItems: "center",
	gap: 6,
	padding: "0 10px 0 12px",
	fontSize: 11.5,
	fontWeight: 500,
	color: "var(--sqlnest-text-secondary)",
	background: "transparent",
	border: "none",
	borderTop: "2px solid transparent",
	borderBottom: "1px solid transparent",
	cursor: "pointer",
	whiteSpace: "nowrap",
	minHeight: 36,
	position: "relative",
	transition: "background-color 120ms ease, color 120ms ease"
};

const tabActiveStyle: CSSProperties = {
	color: "var(--sqlnest-text-primary)",
	background: "var(--sqlnest-elevated)",
	borderTopColor: "var(--sqlnest-accent)",
	borderBottomColor: "var(--sqlnest-elevated)"
};

const badgeStyle: CSSProperties = {
	fontSize: 10,
	fontWeight: 500,
	color: "var(--sqlnest-text-tertiary)",
	background: "var(--sqlnest-surface-hover)",
	padding: "1px 5px",
	borderRadius: 3
};

const closeButtonStyle: CSSProperties = {
	display: "inline-flex",
	alignItems: "center",
	justifyContent: "center",
	width: 16,
	height: 16,
	borderRadius: 3,
	background: "transparent",
	border: "none",
	color: "var(--sqlnest-text-tertiary)",
	cursor: "pointer",
	padding: 0,
	marginLeft: 2
};

const renameInputStyle: CSSProperties = {
	background: "var(--sqlnest-canvas-bg)",
	border: "1px solid var(--sqlnest-accent)",
	borderRadius: 4,
	color: "var(--sqlnest-text-primary)",
	fontSize: 11.5,
	fontWeight: 500,
	padding: "1px 6px",
	outline: "none",
	width: 120
};

export function ConsoleTabs({
	tabs,
	activeTabId,
	onSelect,
	onClose,
	onNew,
	onRename,
	onReorder
}: {
	readonly tabs: readonly ConsoleTab[];
	readonly activeTabId: string;
	readonly onSelect: (id: string) => void;
	readonly onClose: (id: string) => void;
	readonly onNew: () => void;
	readonly onRename: (id: string, name: string) => void;
	readonly onReorder: (fromId: string, toId: string) => void;
}): ReactNode {
	// distance = 5 : évite de trigger un drag sur un simple click (fermer
	// une tab, activer une tab). Pattern dnd-kit standard.
	const sensors = useSensors(
		useSensor(PointerSensor, {
			activationConstraint: { distance: 5 }
		})
	);

	function handleDragEnd(e: DragEndEvent): void {
		const { active, over } = e;
		if (over === null || active.id === over.id) return;
		onReorder(String(active.id), String(over.id));
	}

	return (
		<div style={barStyle}>
			<DndContext
				sensors={sensors}
				collisionDetection={closestCenter}
				onDragEnd={handleDragEnd}
			>
				<SortableContext
					items={tabs.map((t) => t.id)}
					strategy={horizontalListSortingStrategy}
				>
					<div style={scrollingListStyle}>
						{tabs.map((tab) => (
							<SortableTab
								key={tab.id}
								tab={tab}
								isActive={tab.id === activeTabId}
								onSelect={onSelect}
								onClose={onClose}
								onRename={onRename}
							/>
						))}
					</div>
				</SortableContext>
			</DndContext>
			<div style={{ display: "inline-flex", marginLeft: 4 }}>
				<ToolbarButton
					label="Nouvelle query (⌘T)"
					active={false}
					size={26}
					onClick={onNew}
				>
					<IconPlus size={13} stroke={2} />
				</ToolbarButton>
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
}): ReactNode {
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
		opacity: isDragging ? 0.5 : 1
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
				<span style={badgeStyle}>{tab.lastResult.rowCount}</span>
			) : null}
			<span
				role="button"
				tabIndex={-1}
				aria-label={`Fermer ${tab.name}`}
				style={closeButtonStyle}
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
