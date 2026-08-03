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
	/** Hint affiché à droite. Un `string` est stylé en monospace tertiary ;
	 * un `ReactNode` (typiquement `<Kbd>`) est rendu tel quel — utilise
	 * ReactNode pour raccourcis clavier, badges de count, ou pill custom. */
	hint?: string | ReactNode;
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

/** Label de section — texte tertiary uppercase, non-interactif. Utilisé
 * pour regrouper visuellement des blocs d'items (ex : « STRUCTURE » avant
 * les items de reorganisation). Précéder d'un `divider` pour la lisibilité. */
export type ContextMenuSectionLabelItem = {
	kind: "section-label";
	label: string;
};

export type ContextMenuItem =
	| ContextMenuActionItem
	| ContextMenuSubmenuItem
	| ContextMenuDividerItem
	| ContextMenuSectionLabelItem;

export type ContextMenuProps = {
	open: boolean;
	position: { x: number; y: number };
	onClose: () => void;
	items: readonly ContextMenuItem[];
	/** Titre uppercase simple (compat historique). Ignoré si `header` fourni. */
	title?: string;
	/** Slot custom pour un header riche (dot + nom + metadata + badge, …).
	 * Rendu à la place du `title`. Le composant fournit le border-bottom de
	 * séparation ; le contenu du slot gère son propre padding interne. */
	header?: ReactNode;
	width?: number;
};

const rowBase: CSSProperties = {
	display: "flex",
	alignItems: "center",
	justifyContent: "space-between",
	gap: 8,
	width: "100%",
	padding: "5px 9px",
	borderRadius: 6,
	fontSize: 12,
	textAlign: "left",
	transition: "background-color 80ms ease-out",
};

function ItemRow({
	item,
	onPick,
	onOpenSubmenu,
	onCloseSubmenu,
}: {
	item: ContextMenuActionItem | ContextMenuSubmenuItem;
	onPick: () => void;
	onOpenSubmenu?: (rect: DOMRect) => void;
	/** Appelé quand un item non-submenu reçoit le hover — ferme le
	 * submenu actif éventuel (comme un menu natif OS : hover d'un item
	 * frère referme le sous-menu du parent). */
	onCloseSubmenu?: () => void;
}) {
	const ref = useRef<HTMLButtonElement | null>(null);
	const [hovered, setHovered] = useState(false);
	const isSubmenu = item.kind === "submenu";
	const isActive = item.kind === "action" && item.active;
	const isDanger = item.kind === "action" && item.danger;
	// Layered bg : hover > active > transparent. Hover d'un item danger
	// prend une teinte rouge soft ; sinon la surface de hover neutre.
	const bgHover = isDanger
		? "var(--sqlnest-danger-soft, rgba(255,80,80,0.12))"
		: "var(--sqlnest-surface-hover, rgba(255,255,255,0.06))";
	const style: CSSProperties = {
		...rowBase,
		background: hovered
			? bgHover
			: isActive
				? "var(--sqlnest-accent-soft)"
				: "transparent",
		color: isDanger
			? "var(--sqlnest-danger)"
			: isActive
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
				setHovered(true);
				if (isSubmenu && ref.current) {
					onOpenSubmenu?.(ref.current.getBoundingClientRect());
				} else {
					// Item frère — referme un submenu potentiellement ouvert.
					onCloseSubmenu?.();
				}
			}}
			onMouseLeave={() => setHovered(false)}
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
				typeof item.hint === "string" ? (
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
				) : (
					/* ReactNode hint (typiquement `<Kbd>`) — rendu tel quel dans un
					 * wrapper flex-safe (flexShrink 0 pour ne pas être écrasé). */
					<span style={{ flexShrink: 0, display: "inline-flex", gap: 4 }}>
						{item.hint}
					</span>
				)
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
	header,
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
			{/* Backdrop transparent full-screen — capture tous les événements
			 * qui ne visent PAS le menu (le menu container est en zIndex 9999,
			 * le backdrop en 9998, donc le menu reste cliquable au-dessus).
			 * Sans lui, un scroll molette pendant que le menu est ouvert pan
			 * le canvas ReactFlow en dessous — visible = user perd sa vue en
			 * essayant de scroll vers un item bas. */}
			<div
				aria-hidden
				onMouseDown={(e) => {
					e.stopPropagation();
					onClose();
				}}
				onContextMenu={(e) => {
					// Empêche le vrai menu contextuel navigateur quand user
					// right-click sur le vide pendant que le menu custom est ouvert.
					e.preventDefault();
					e.stopPropagation();
					onClose();
				}}
				onWheel={(e) => e.stopPropagation()}
				style={{
					position: "fixed",
					inset: 0,
					zIndex: 9998,
					background: "transparent",
				}}
			/>
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
					{header ? (
						<Box
							style={{
								borderBottom: "1px solid var(--sqlnest-border-subtle)",
								marginBottom: 4,
							}}
						>
							{header}
						</Box>
					) : title ? (
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
							if (item.kind === "section-label") {
								return (
									<Text
										key={`s-${i}`}
										size="xs"
										fw={700}
										tt="uppercase"
										px="xs"
										pt={6}
										pb={4}
										style={{
											letterSpacing: 0.5,
											color: "var(--sqlnest-text-tertiary)",
										}}
									>
										{item.label}
									</Text>
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
									onCloseSubmenu={() => setSubmenu(null)}
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
							{submenu.item.items.map((child, i) => {
								if (child.kind === "divider") {
									return (
										<Box
											role="separator"
											key={`ds-${i}`}
											style={{
												height: 1,
												background: "var(--sqlnest-border-subtle)",
												margin: "4px 6px",
											}}
										/>
									);
								}
								if (child.kind === "section-label") {
									return (
										<Text
											key={`ss-${i}`}
											size="xs"
											fw={700}
											tt="uppercase"
											px="xs"
											pt={6}
											pb={4}
											style={{
												letterSpacing: 0.5,
												color: "var(--sqlnest-text-tertiary)",
											}}
										>
											{child.label}
										</Text>
									);
								}
								return (
									<ItemRow
										key={child.id}
										item={child}
										onPick={() => {
											if (child.kind === "action") child.onClick?.();
											onClose();
										}}
									/>
								);
							})}
						</Stack>
					</Box>
				) : null}
			</div>
		</Portal>
	);
}
