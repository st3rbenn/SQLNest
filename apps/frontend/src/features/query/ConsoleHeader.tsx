/**
 * Top bar de la console SNQL fullscreen : back button (canvas) OU Fermer
 * (popout), title + connection name, hints keyboard, bouton Détacher,
 * bouton Historique, bouton Exécuter (primary).
 *
 * Utilise les patterns app existants : Link TanStack pour back nav,
 * classe `sqlnest-header-cta` pour les CTAs outlined, Button DS variant
 * primary pour l'action principale, HintPill pour les hints `⌘⏎`.
 */

import { Button, HintPill, useModKeyLabel } from "@sqlnest/design-system";
import { ActionIcon, Menu, Tooltip } from "@mantine/core";
import {
	IconArrowLeft,
	IconExternalLink,
	IconHistory,
	IconTerminal2,
	IconX
} from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import type { CSSProperties } from "react";

const headerStyle: CSSProperties = {
	display: "flex",
	alignItems: "center",
	justifyContent: "space-between",
	gap: 16,
	padding: "0 16px",
	minHeight: 48,
	background: "var(--sqlnest-surface)",
	borderBottom: "1px solid var(--sqlnest-border)",
	flexShrink: 0
};

const leftGroupStyle: CSSProperties = {
	display: "flex",
	alignItems: "center",
	gap: 12,
	minWidth: 0
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

const titleGroupStyle: CSSProperties = {
	display: "inline-flex",
	alignItems: "center",
	gap: 8,
	color: "var(--sqlnest-text-primary)",
	fontSize: 13,
	fontWeight: 600,
	minWidth: 0
};

const connNameStyle: CSSProperties = {
	fontSize: 12,
	fontWeight: 400,
	color: "var(--sqlnest-text-secondary)",
	overflow: "hidden",
	textOverflow: "ellipsis",
	whiteSpace: "nowrap",
	maxWidth: 240
};

const rightGroupStyle: CSSProperties = {
	display: "flex",
	alignItems: "center",
	gap: 8
};

const historyButtonStyle: CSSProperties = {
	display: "inline-flex",
	alignItems: "center",
	gap: 6,
	fontSize: 11,
	color: "var(--sqlnest-text-primary)",
	background: "var(--sqlnest-surface)",
	border: "1px solid var(--sqlnest-border)",
	borderRadius: 5,
	padding: "4px 8px",
	cursor: "pointer",
	minHeight: 26
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

export interface ConsoleHeaderProps {
	readonly connectionName: string;
	readonly teamSlug: string;
	readonly connId: string;
	readonly isPopout: boolean;
	readonly canExecute: boolean;
	readonly isRunning: boolean;
	readonly onExecute: () => void;
	readonly onDetach: () => void;
	readonly history: readonly string[];
	readonly onHistorySelect: (source: string) => void;
	readonly onHistoryClear: () => void;
}

export function ConsoleHeader({
	connectionName,
	teamSlug,
	connId,
	isPopout,
	canExecute,
	isRunning,
	onExecute,
	onDetach,
	history,
	onHistorySelect,
	onHistoryClear
}: ConsoleHeaderProps): React.ReactNode {
	const modKey = useModKeyLabel();

	return (
		<div style={headerStyle}>
			<div style={leftGroupStyle}>
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
				<span style={titleGroupStyle}>
					<IconTerminal2 size={15} stroke={2} />
					<span>Console</span>
					<span style={connNameStyle} title={connectionName}>
						· {connectionName}
					</span>
				</span>
			</div>

			<HintPill keys={[modKey, "↵"]}>Exécuter</HintPill>

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

				{!isPopout ? (
					<button
						type="button"
						style={historyButtonStyle}
						className="sqlnest-header-cta"
						onClick={onDetach}
						title={`Détacher (${modKey}⇧K)`}
					>
						<IconExternalLink size={12} stroke={2} />
						Détacher
					</button>
				) : null}

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
		</div>
	);
}
