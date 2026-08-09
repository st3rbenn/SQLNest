/**
 * Ligne compacte pour la vue "list" de la gallery — reprend les mêmes
 * infos que `DbCard` (nom, engine, status, dernière activité) sur une
 * seule row, cliquable pour navigate vers le canvas.
 */

import { Link } from "@tanstack/react-router";
import type { CSSProperties } from "react";
import { useCurrentTeam } from "../teams/useCurrentTeam";
import type { DbConnection } from "../db-connections/useDbConnections";

const rowStyle: CSSProperties = {
	display: "grid",
	gridTemplateColumns: "1fr 120px 160px 90px",
	alignItems: "center",
	gap: 16,
	padding: "10px 14px",
	background: "var(--sqlnest-surface)",
	border: "1px solid var(--sqlnest-border-subtle)",
	borderRadius: 8,
	textDecoration: "none",
	color: "var(--sqlnest-text-primary)",
	transition: "border-color 160ms ease"
};

const nameStyle: CSSProperties = {
	fontSize: 13,
	fontWeight: 600,
	color: "var(--sqlnest-text-primary)",
	overflow: "hidden",
	textOverflow: "ellipsis",
	whiteSpace: "nowrap"
};

const metaStyle: CSSProperties = {
	fontSize: 11.5,
	color: "var(--sqlnest-text-secondary)",
	overflow: "hidden",
	textOverflow: "ellipsis",
	whiteSpace: "nowrap"
};

const statusStyle = (isOnline: boolean): CSSProperties => ({
	display: "inline-flex",
	alignItems: "center",
	gap: 6,
	fontSize: 11,
	fontWeight: 500,
	color: isOnline
		? "var(--sqlnest-success, hsl(140, 55%, 55%))"
		: "var(--sqlnest-text-tertiary)"
});

const dotStyle = (isOnline: boolean): CSSProperties => ({
	width: 6,
	height: 6,
	borderRadius: "50%",
	background: isOnline
		? "var(--sqlnest-success, hsl(140, 55%, 55%))"
		: "var(--sqlnest-text-tertiary)"
});

function formatRelative(iso: string | null): string {
	if (!iso) return "—";
	const ms = Date.parse(iso);
	if (Number.isNaN(ms)) return "—";
	const delta = Date.now() - ms;
	if (delta < 60_000) return "à l'instant";
	if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} min`;
	if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} h`;
	if (delta < 30 * 86_400_000) return `${Math.floor(delta / 86_400_000)} j`;
	return new Date(ms).toLocaleDateString();
}

export function DbRow({
	connection,
	onClick,
	isPending
}: {
	readonly connection: DbConnection;
	readonly onClick?: (connId: string) => void;
	readonly isPending?: boolean;
}): React.ReactNode {
	const team = useCurrentTeam();
	const teamSlug = team?.slug ?? null;
	const isOnline = connection.isOnline ?? true;
	const engineLabel = connection.engine === "mongodb" ? "MongoDB" : "Postgres";
	const lastActivity = formatRelative(
		connection.lastSeenAt ?? connection.activeSince ?? connection.createdAt
	);

	const style: CSSProperties = {
		...rowStyle,
		borderColor: isPending
			? "var(--sqlnest-accent-muted)"
			: rowStyle.border?.toString().includes("border-subtle")
				? "var(--sqlnest-border-subtle)"
				: "var(--sqlnest-border-subtle)"
	};

	const content = (
		<>
			<div style={nameStyle} title={connection.name}>
				{connection.name}
			</div>
			<div style={metaStyle}>{engineLabel}</div>
			<div style={metaStyle}>{lastActivity}</div>
			<div style={statusStyle(isOnline)}>
				<span style={dotStyle(isOnline)} />
				{isOnline ? "En ligne" : "Hors ligne"}
			</div>
		</>
	);

	if (teamSlug) {
		return (
			<Link
				to="/team/$teamSlug/canvas/$connId"
				params={{ teamSlug, connId: connection.id }}
				className="sqlnest-db-row"
				style={style}
				onClick={(e) => {
					if (onClick) {
						e.preventDefault();
						onClick(connection.id);
					}
				}}
			>
				{content}
			</Link>
		);
	}
	return (
		<Link
			to="/canvas/$connId"
			params={{ connId: connection.id }}
			className="sqlnest-db-row"
			style={style}
			onClick={(e) => {
				if (onClick) {
					e.preventDefault();
					onClick(connection.id);
				}
			}}
		>
			{content}
		</Link>
	);
}
