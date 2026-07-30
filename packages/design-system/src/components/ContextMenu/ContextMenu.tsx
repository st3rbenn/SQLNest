import { Box, Portal, Stack, Text, UnstyledButton } from "@mantine/core";
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
				? "var(--mantine-color-brand-0)"
				: "transparent",
		color:
			item.kind === "action" && item.danger
				? "var(--mantine-color-red-7)"
				: item.kind === "action" && item.active
					? "var(--mantine-color-brand-7)"
					: "var(--mantine-color-slate-7)",
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
			<span
				style={{ display: "inline-flex", alignItems: "center", gap: 8 }}
			>
				{item.icon}
				{item.label}
			</span>
			{isSubmenu ? (
				<span aria-hidden style={{ color: "var(--mantine-color-slate-4)" }}>
					›
				</span>
			) : "hint" in item && item.hint ? (
				<Text
					ff="monospace"
					size="xs"
					c="slate.5"
					style={{ whiteSpace: "nowrap" }}
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

	useEffect(() => {
		if (!open) {
			setSubmenu(null);
			return;
		}
		function onKey(e: KeyboardEvent) {
			if (e.key === "Escape") onClose();
		}
		function onDown(e: MouseEvent) {
			if (!containerRef.current) return;
			if (containerRef.current.contains(e.target as Node)) return;
			onClose();
		}
		document.addEventListener("keydown", onKey);
		document.addEventListener("mousedown", onDown);
		return () => {
			document.removeEventListener("keydown", onKey);
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
						background: "#fff",
						border: "1px solid var(--mantine-color-slate-2)",
						borderRadius: 10,
						boxShadow: "0 16px 40px rgba(15,23,42,0.18)",
						padding: 6,
						zIndex: 9999,
					}}
				>
					{title ? (
						<Text
							size="xs"
							c="slate.4"
							fw={700}
							tt="uppercase"
							px="xs"
							pt={4}
							pb={2}
							style={{ letterSpacing: 0.5 }}
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
											background: "var(--mantine-color-slate-1)",
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
							background: "#fff",
							border: "1px solid var(--mantine-color-slate-2)",
							borderRadius: 10,
							boxShadow: "0 16px 40px rgba(15,23,42,0.18)",
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
											background: "var(--mantine-color-slate-1)",
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
