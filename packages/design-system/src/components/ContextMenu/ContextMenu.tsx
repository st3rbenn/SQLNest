import { Box, Portal, Stack, Text, UnstyledButton } from "@mantine/core";
import { useHotkeys } from "@mantine/hooks";
import {
	type CSSProperties,
	type ReactNode,
	useEffect,
	useRef,
	useState,
} from "react";

export type ContextMenuActionItem = {
	kind: "action";
	id: string;
	label: string;
	icon?: ReactNode;
	hint?: string;
	active?: boolean;
	danger?: boolean;
	onClick?: () => void;
};

export type ContextMenuSubmenuItem = {
	kind: "submenu";
	id: string;
	label: string;
	icon?: ReactNode;
	items: readonly ContextMenuItem[];
};

export type ContextMenuDividerItem = { kind: "divider" };

export type ContextMenuItem =
	| ContextMenuActionItem
	| ContextMenuSubmenuItem
	| ContextMenuDividerItem;

export type ContextMenuProps = {
	open: boolean;
	position: { x: number; y: number };
	onClose: () => void;
	items: readonly ContextMenuItem[];
	title?: string;
	width?: number;
};

const rowBase: CSSProperties = {
	display: "flex",
	alignItems: "center",
	justifyContent: "space-between",
	gap: 8,
	width: "100%",
	padding: "7px 10px",
	borderRadius: 6,
	fontSize: 12.5,
	textAlign: "left",
};

function ItemRow({
	item,
	onPick,
	onOpenSubmenu,
}: {
	item: ContextMenuActionItem | ContextMenuSubmenuItem;
	onPick: () => void;
	onOpenSubmenu?: (rect: DOMRect) => void;
}) {
	const ref = useRef<HTMLButtonElement | null>(null);
	const isSubmenu = item.kind === "submenu";
	const style: CSSProperties = {
		...rowBase,
		background:
			item.kind === "action" && item.active
				? "var(--sqlnest-accent-soft)"
				: "transparent",
		color:
			item.kind === "action" && item.danger
				? "var(--sqlnest-danger)"
				: item.kind === "action" && item.active
					? "var(--sqlnest-accent)"
					: "var(--sqlnest-text-secondary)",
	};
	return (
		<UnstyledButton
			ref={ref}
			role="menuitem"
			style={style}
			onClick={() => {
				if (isSubmenu) {
					if (ref.current) onOpenSubmenu?.(ref.current.getBoundingClientRect());
				} else {
					onPick();
				}
			}}
			onMouseEnter={() => {
				if (isSubmenu && ref.current) {
					onOpenSubmenu?.(ref.current.getBoundingClientRect());
				}
			}}
		>
			{/* Label span : `minWidth: 0` + `flex: 1` obligatoire pour que la
			 * troncature s'applique dans un flex parent — sinon `flex-shrink`
			 * par défaut ne kick pas, le label wrappe sur plusieurs lignes et
			 * le hint se retrouve écrasé (bug visible avec des labels ou hints
			 * longs, ex : contextmenu d'une table nommée `resource_software_link`). */}
			<span
				style={{
					display: "inline-flex",
					alignItems: "center",
					gap: 8,
					minWidth: 0,
					flex: 1,
					overflow: "hidden",
				}}
			>
				{item.icon}
				<span
					style={{
						overflow: "hidden",
						textOverflow: "ellipsis",
						whiteSpace: "nowrap",
					}}
				>
					{item.label}
				</span>
			</span>
			{isSubmenu ? (
				<span
					aria-hidden
					style={{
						color: "var(--sqlnest-text-tertiary)",
						flexShrink: 0,
					}}
				>
					›
				</span>
			) : "hint" in item && item.hint ? (
				<Text
					ff="monospace"
					size="xs"
					style={{
						whiteSpace: "nowrap",
						color: "var(--sqlnest-text-tertiary)",
						flexShrink: 0,
						maxWidth: "40%",
						overflow: "hidden",
						textOverflow: "ellipsis",
					}}
				>
					{item.hint}
				</Text>
			) : null}
		</UnstyledButton>
	);
}

/**
 * Menu contextuel positionné en coordonnées écran (portal + `position: fixed`).
 * Se ferme sur `Escape`, clic-extérieur, ou choix d'action. Sous-menus rendus
 * en cascade à la position de leur ancre.
 */
export function ContextMenu({
	open,
	position,
	onClose,
	items,
	title,
	width = 260,
}: ContextMenuProps) {
	const containerRef = useRef<HTMLDivElement | null>(null);
	const [submenu, setSubmenu] = useState<{
		item: ContextMenuSubmenuItem;
		x: number;
		y: number;
	} | null>(null);

	// Escape : useHotkeys monté inconditionnellement (règle React) ; le
	// handler no-op si le menu est fermé — équivalent au listener
	// conditionnel d'avant, sans coût réel.
	useHotkeys([
		[
			"Escape",
			() => {
				if (open) onClose();
			}
		]
	]);
	useEffect(() => {
		if (!open) {
			setSubmenu(null);
			return;
		}
		// Click-outside : reste sur addEventListener natif — pas d'API
		// Mantine simple pour un check via `containerRef.current.contains`.
		function onDown(e: MouseEvent) {
			if (!containerRef.current) return;
			if (containerRef.current.contains(e.target as Node)) return;
			onClose();
		}
		document.addEventListener("mousedown", onDown);
		return () => {
			document.removeEventListener("mousedown", onDown);
		};
	}, [open, onClose]);

	if (!open) return null;

	return (
		<Portal>
			<div ref={containerRef}>
				<Box
					role="menu"
					style={{
						position: "fixed",
						left: position.x,
						top: position.y,
						width,
						background: "var(--sqlnest-surface)",
						border: "1px solid var(--sqlnest-border)",
						borderRadius: 10,
						boxShadow: "0 16px 40px rgba(0,0,0,0.55)",
						padding: 6,
						zIndex: 9999,
					}}
				>
					{title ? (
						<Text
							size="xs"
							fw={700}
							tt="uppercase"
							px="xs"
							pt={4}
							pb={2}
							style={{
								letterSpacing: 0.5,
								color: "var(--sqlnest-text-tertiary)",
							}}
						>
							{title}
						</Text>
					) : null}
					<Stack gap={0}>
						{items.map((item, i) => {
							if (item.kind === "divider") {
								return (
									<Box
										role="separator"
										key={`d-${i}`}
										style={{
											height: 1,
											background: "var(--sqlnest-border-subtle)",
											margin: "4px 6px",
										}}
									/>
								);
							}
							return (
								<ItemRow
									key={item.id}
									item={item}
									onPick={() => {
										if (item.kind === "action") item.onClick?.();
										onClose();
									}}
									onOpenSubmenu={(rect) => {
										if (item.kind === "submenu") {
											setSubmenu({
												item,
												x: rect.right,
												y: rect.top,
											});
										}
									}}
								/>
							);
						})}
					</Stack>
				</Box>
				{submenu ? (
					<Box
						role="menu"
						style={{
							position: "fixed",
							left: submenu.x + 4,
							top: submenu.y,
							width,
							background: "var(--sqlnest-surface)",
							border: "1px solid var(--sqlnest-border)",
							borderRadius: 10,
							boxShadow: "0 16px 40px rgba(0,0,0,0.55)",
							padding: 6,
							zIndex: 10000,
						}}
					>
						<Stack gap={0}>
							{submenu.item.items.map((child, i) =>
								child.kind === "divider" ? (
									<Box
										role="separator"
										key={`ds-${i}`}
										style={{
											height: 1,
											background: "var(--sqlnest-border-subtle)",
											margin: "4px 6px",
										}}
									/>
								) : (
									<ItemRow
										key={child.id}
										item={child}
										onPick={() => {
											if (child.kind === "action") child.onClick?.();
											onClose();
										}}
									/>
								),
							)}
						</Stack>
					</Box>
				) : null}
			</div>
		</Portal>
	);
}
