import { Menu, UnstyledButton } from "@mantine/core";
import {
	IconChevronDown,
	IconLayoutSidebarLeftCollapse,
	IconLayoutSidebarLeftExpand
} from "@tabler/icons-react";
import type { CSSProperties } from "react";

/**
 * Bar « fichier » du canvas — chevron dropdown Files + nom de la DB +
 * toggle drawer. Deux variants selon si le drawer est ouvert ou pas :
 *   - `floating` : container flottant top-left du canvas (drawer fermé).
 *   - `embedded` : intégré dans le header du DrawerPane (drawer ouvert).
 *
 * Le toggle change d'icône (collapse ⇄ expand) selon `drawerVisible`.
 */

type Variant = "floating" | "embedded";

const floatingContainerStyle: CSSProperties = {
	position: "absolute",
	top: 12,
	left: 8,
	zIndex: 5,
	display: "flex",
	alignItems: "stretch",
	gap: 2,
	padding: 4,
	background: "var(--sqlnest-elevated)",
	border: "1px solid var(--sqlnest-border-subtle)",
	borderRadius: 10,
	boxShadow: "var(--sqlnest-shadow-floating)"
};

const embeddedContainerStyle: CSSProperties = {
	display: "flex",
	alignItems: "stretch",
	gap: 2,
	padding: 0,
	background: "transparent",
	border: "none",
	borderRadius: 0
};

const chevronTriggerStyle: CSSProperties = {
	display: "inline-flex",
	alignItems: "center",
	justifyContent: "center",
	padding: "6px 8px",
	borderRadius: 6,
	color: "var(--sqlnest-text-secondary)"
};

const dbNameStyle: CSSProperties = {
	display: "inline-flex",
	alignItems: "center",
	padding: "6px 10px",
	borderRadius: 6,
	color: "var(--sqlnest-text-primary)",
	fontSize: 13,
	fontWeight: 500,
	maxWidth: 220,
	overflow: "hidden",
	textOverflow: "ellipsis",
	whiteSpace: "nowrap"
};

const toggleStyle: CSSProperties = {
	display: "inline-flex",
	alignItems: "center",
	justifyContent: "center",
	padding: "6px 8px",
	borderRadius: 6,
	color: "var(--sqlnest-text-secondary)",
	marginLeft: "auto"
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
	const container =
		variant === "floating" ? floatingContainerStyle : embeddedContainerStyle;
	return (
		<div style={container}>
			<FilesMenu />
			<UnstyledButton
				className="sqlnest-menu-item"
				aria-label={`Renommer ${dbName} (bientôt)`}
				style={dbNameStyle}
			>
				{dbName}
			</UnstyledButton>
			<UnstyledButton
				className="sqlnest-menu-item"
				aria-label={
					drawerVisible ? "Masquer le drawer gauche" : "Afficher le drawer gauche"
				}
				onClick={onToggleDrawer}
				style={toggleStyle}
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

function FilesMenu(): React.ReactNode {
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
					style={chevronTriggerStyle}
				>
					<IconChevronDown size={16} stroke={2} aria-hidden />
				</UnstyledButton>
			</Menu.Target>
			<Menu.Dropdown>
				<Menu.Item disabled>Retour aux canvas</Menu.Item>
				<Menu.Item disabled>Exporter le schéma</Menu.Item>
				<Menu.Item disabled>Exporter sous…</Menu.Item>
				<Menu.Divider />
				<Menu.Item disabled>Dupliquer</Menu.Item>
				<Menu.Item disabled>Renommer</Menu.Item>
			</Menu.Dropdown>
		</Menu>
	);
}
