import { Menu, UnstyledButton } from "@mantine/core";
import {
	IconChevronDown,
	IconLayoutSidebarLeftCollapse,
	IconLayoutSidebarLeftExpand
} from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import type { CSSProperties } from "react";

/**
 * Bar « fichier » du canvas — chevron dropdown Files + nom de la DB
 * + accès au drawer schéma.
 *
 * Deux variants :
 *   - `floating` : container top-left du canvas quand le drawer est
 *     fermé. Nom de la DB et bouton d'ouverture drawer sont FUSIONNÉS
 *     en un seul btn (le click ouvre le drawer, le rename inline se
 *     fera dans le drawer une fois ouvert).
 *   - `embedded` : rendu dans le header du DrawerPane quand le drawer
 *     est ouvert. Nom + toggle collapse séparés (l'user peut cliquer
 *     le nom pour rename plus tard sans fermer le drawer).
 */

type Variant = "floating" | "embedded";

const floatingContainerStyle: CSSProperties = {
	position: "absolute",
	top: 12,
	left: 12,
	zIndex: 5,
	display: "flex",
	alignItems: "stretch",
	gap: 0,
	padding: 0,
	background: "var(--sqlnest-elevated)",
	border: "1px solid var(--sqlnest-border-subtle)",
	borderRadius: 10,
	boxShadow: "var(--sqlnest-shadow-floating)"
};

const embeddedContainerStyle: CSSProperties = {
	display: "flex",
	alignItems: "center",
	gap: 2,
	padding: 0
};

const baseBtnStyle: CSSProperties = {
	display: "inline-flex",
	alignItems: "center",
	color: "var(--sqlnest-text-primary)",
	fontSize: 14,
	fontWeight: 500
};

const menuStyles = {
	dropdown: {
		background: "var(--sqlnest-surface)",
		border: "1px solid var(--sqlnest-border-subtle)",
		padding: 3
	},
	item: {
		fontSize: 12,
		color: "var(--sqlnest-text-primary)",
		padding: "5px 8px",
		borderRadius: 5,
		minHeight: 0
	}
} as const;

const menuClassNames = {
	item: "sqlnest-menu-item"
} as const;

export function CanvasFilesHUD({
	dbName,
	drawerVisible,
	onToggleDrawer,
	variant = "floating"
}: {
	readonly dbName: string;
	readonly drawerVisible: boolean;
	readonly onToggleDrawer: () => void;
	readonly variant?: Variant;
}): React.ReactNode {
	if (variant === "floating") {
		return (
			<div style={floatingContainerStyle}>
				<FilesMenu radius="10px 0 0 10px" padding="11px 14px" />
				<OpenPanelButton dbName={dbName} onClick={onToggleDrawer} />
			</div>
		);
	}
	return (
		<div style={embeddedContainerStyle}>
			<FilesMenu radius={6} padding="6px 8px" />
			<UnstyledButton
				className="sqlnest-menu-item"
				aria-label={`Renommer ${dbName} (bientôt)`}
				style={{
					...baseBtnStyle,
					padding: "6px 10px",
					borderRadius: 6,
					maxWidth: 220,
					overflow: "hidden",
					textOverflow: "ellipsis",
					whiteSpace: "nowrap"
				}}
			>
				{dbName}
			</UnstyledButton>
			<UnstyledButton
				className="sqlnest-menu-item"
				aria-label="Masquer le drawer gauche"
				onClick={onToggleDrawer}
				style={{
					...baseBtnStyle,
					padding: "6px 8px",
					borderRadius: 6,
					marginLeft: "auto",
					color: "var(--sqlnest-text-primary)"
				}}
			>
				{drawerVisible ? (
					<IconLayoutSidebarLeftCollapse size={16} stroke={2} aria-hidden />
				) : (
					<IconLayoutSidebarLeftExpand size={16} stroke={2} aria-hidden />
				)}
			</UnstyledButton>
		</div>
	);
}

function OpenPanelButton({
	dbName,
	onClick
}: {
	readonly dbName: string;
	readonly onClick: () => void;
}): React.ReactNode {
	return (
		<UnstyledButton
			className="sqlnest-menu-item"
			onClick={onClick}
			aria-label={`Ouvrir le schéma de ${dbName}`}
			style={{
				...baseBtnStyle,
				gap: 12,
				padding: "11px 14px",
				borderRadius: "0 10px 10px 0",
				maxWidth: 260
			}}
		>
			<span
				style={{
					overflow: "hidden",
					textOverflow: "ellipsis",
					whiteSpace: "nowrap"
				}}
			>
				{dbName}
			</span>
			<IconLayoutSidebarLeftExpand size={16} stroke={2} aria-hidden />
		</UnstyledButton>
	);
}

function FilesMenu({
	radius,
	padding
}: {
	readonly radius: string | number;
	readonly padding: string;
}): React.ReactNode {
	return (
		<Menu
			shadow="md"
			width={196}
			position="bottom-start"
			withArrow={false}
			offset={8}
			radius={8}
			transitionProps={{ duration: 0 }}
			styles={menuStyles}
			classNames={menuClassNames}
		>
			<Menu.Target>
				<UnstyledButton
					className="sqlnest-menu-item"
					aria-label="Actions fichier"
					style={{
						display: "inline-flex",
						alignItems: "center",
						justifyContent: "center",
						padding,
						borderRadius: radius,
						color: "var(--sqlnest-text-primary)"
					}}
				>
					<IconChevronDown size={18} stroke={2} aria-hidden />
				</UnstyledButton>
			</Menu.Target>
			<Menu.Dropdown>
				<Menu.Item component={Link} to="/">
					Retour aux canvas
				</Menu.Item>
				<Menu.Divider />
				<Menu.Item disabled>Exporter le schéma</Menu.Item>
				<Menu.Item disabled>Exporter sous…</Menu.Item>
				<Menu.Divider />
				<Menu.Item disabled>Dupliquer</Menu.Item>
				<Menu.Item disabled>Renommer</Menu.Item>
			</Menu.Dropdown>
		</Menu>
	);
}
