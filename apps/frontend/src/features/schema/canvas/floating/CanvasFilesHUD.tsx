import { Menu, UnstyledButton } from "@mantine/core";
import { IconChevronDown } from "@tabler/icons-react";
import type { CSSProperties } from "react";

/**
 * HUD flottant top-left du canvas — visible uniquement quand le
 * DrawerPane est fermé. Regroupe les actions fichier (dropdown Files)
 * et affiche le nom de la DB (hover → futur rename).
 *
 * Le toggle du DrawerPane est monté à côté (voir CanvasLeftPanel).
 */

const containerStyle: CSSProperties = {
	position: "absolute",
	top: 12,
	left: 44,
	zIndex: 5,
	display: "flex",
	alignItems: "center",
	gap: 6,
	padding: 7,
	background: "var(--sqlnest-elevated)",
	border: "1px solid var(--sqlnest-border-subtle)",
	borderRadius: 10,
	boxShadow: "var(--sqlnest-shadow-floating)"
};

const chevronTriggerStyle: CSSProperties = {
	display: "inline-flex",
	alignItems: "center",
	justifyContent: "center",
	width: 22,
	height: 22,
	borderRadius: 6,
	color: "var(--sqlnest-text-secondary)"
};

const dbNameStyle: CSSProperties = {
	display: "inline-flex",
	alignItems: "center",
	padding: "3px 8px",
	borderRadius: 6,
	color: "var(--sqlnest-text-primary)",
	fontSize: 12,
	fontWeight: 500,
	maxWidth: 220,
	overflow: "hidden",
	textOverflow: "ellipsis",
	whiteSpace: "nowrap"
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
	dbName
}: {
	readonly dbName: string;
}): React.ReactNode {
	return (
		<div style={containerStyle}>
			<FilesMenu />
			<UnstyledButton
				className="sqlnest-menu-item"
				aria-label={`Renommer ${dbName} (bientôt)`}
				style={dbNameStyle}
			>
				{dbName}
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
					<IconChevronDown size={14} stroke={2} aria-hidden />
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
