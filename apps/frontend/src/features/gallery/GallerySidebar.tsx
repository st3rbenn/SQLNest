import { Link } from "@tanstack/react-router";
import type { CSSProperties } from "react";
import { UserBadge } from "../auth/UserBadge";
import { TeamSelector } from "../teams/TeamSelector";
import { useCurrentTeam } from "../teams/useCurrentTeam";

/**
 * Sidebar partagée entre la gallery (`/team/:slug/recents`,
 * `/team/:slug/canvas`) et la page de pairing (`/team/:slug/pair`).
 * 2 blocs :
 *   1. Perso — UserBadge + nav cross-team (Recents)
 *   2. Team  — TeamSelector + nav team-scoped (Canvas, Saved Queries,
 *              Tests)
 * Le CTA « Nouveau canvas » vit dans le PageHead à droite (pas ici).
 */

const sidebarStyle: CSSProperties = {
	width: 260,
	background: "var(--sqlnest-surface)",
	borderRight: "1px solid var(--sqlnest-border)",
	display: "flex",
	flexDirection: "column",
	flexShrink: 0
};

export type SidebarActiveItem = "recents" | "canvas";

export function GallerySidebar({
	teamSlug,
	activeItem
}: {
	readonly teamSlug: string | null;
	readonly activeItem?: SidebarActiveItem;
}): React.ReactNode {
	const team = useCurrentTeam();
	return (
		<aside style={sidebarStyle}>
			{/* ── Bloc PERSONAL : user + nav cross-team. ────────────────
			    Padding top/bottom = 12px pour matcher le header (56px min
			    height → centre à 28px, trigger UserBadge à ~28px du top
			    du wrapper). Sans ça l'avatar sidebar remonte 5px au-dessus
			    du CTA header — désaligné à l'œil. */}
			<div style={{ padding: "12px 12px 8px" }}>
				<UserBadge />
			</div>
			<div style={{ padding: "2px 12px 8px" }}>
				{teamSlug ? (
					<NavItem
						label="Recents"
						icon={<ClockIcon />}
						active={activeItem === "recents"}
						to="/team/$teamSlug/recents"
						params={{ teamSlug }}
					/>
				) : (
					<NavItem label="Recents" icon={<ClockIcon />} active={false} />
				)}
			</div>

			<div
				style={{
					height: 1,
					background: "var(--sqlnest-border)",
					margin: 0
				}}
			/>

			{/* ── Bloc TEAM : sélecteur team + nav team-scoped. ──────── */}
			<div style={{ padding: "8px 12px 4px" }}>
				{team ? (
					<TeamSelector currentTeam={team} />
				) : (
					<div style={{ height: 32 }} />
				)}
			</div>
			<div style={{ padding: "2px 12px", display: "flex", flexDirection: "column", gap: 2 }}>
				{teamSlug ? (
					<NavItem
						label="Canvas"
						icon={<CanvasIcon />}
						active={activeItem === "canvas"}
						to="/team/$teamSlug/canvas"
						params={{ teamSlug }}
					/>
				) : (
					<NavItem label="Canvas" icon={<CanvasIcon />} active={false} />
				)}

				{/* Placeholders V2+ — non cliquables, tooltip explicite.
				    Objectif : signaler la roadmap sans faire d'ombre à ce
				    qui existe déjà. */}
				<NavItem
					label="Saved Queries"
					icon={<BookmarkIcon />}
					active={false}
					soon
				/>
				<NavItem label="Tests" icon={<TestIcon />} active={false} soon />
			</div>

			<div style={{ flex: 1 }} />
		</aside>
	);
}

function NavItem({
	label,
	icon,
	active,
	to,
	params,
	soon = false
}: {
	readonly label: string;
	readonly icon: React.ReactNode;
	readonly active: boolean;
	readonly to?:
		| "/team/$teamSlug"
		| "/team/$teamSlug/recents"
		| "/team/$teamSlug/canvas";
	readonly params?: { readonly teamSlug: string };
	readonly soon?: boolean;
}): React.ReactNode {
	const className = active
		? "sqlnest-sidebar-item sqlnest-sidebar-item--active"
		: "sqlnest-sidebar-item";
	const style: CSSProperties = {
		display: "flex",
		alignItems: "center",
		gap: 10,
		padding: "6px 8px",
		color: soon ? "var(--sqlnest-text-tertiary)" : "var(--sqlnest-text-title)",
		borderRadius: 6,
		fontSize: 12,
		fontWeight: 500,
		cursor: soon ? "not-allowed" : to ? "pointer" : "default",
		textDecoration: "none",
		opacity: soon ? 0.6 : 1
	};
	const inner = (
		<>
			<span
				style={{
					width: 20,
					height: 20,
					display: "inline-flex",
					alignItems: "center",
					justifyContent: "center",
					flexShrink: 0
				}}
			>
				{icon}
			</span>
			<span style={{ flex: 1 }}>{label}</span>
			{soon ? (
				<span
					style={{
						fontSize: 9,
						fontWeight: 600,
						letterSpacing: 0.4,
						textTransform: "uppercase",
						color: "var(--sqlnest-text-tertiary)",
						border: "1px solid var(--sqlnest-border-subtle)",
						padding: "1px 5px",
						borderRadius: 3
					}}
				>
					Soon
				</span>
			) : null}
		</>
	);
	if (to && params && !soon) {
		return (
			<Link to={to} params={params} className={className} style={style}>
				{inner}
			</Link>
		);
	}
	return (
		<div
			className={className}
			style={style}
			title={soon ? "Bientôt disponible" : undefined}
		>
			{inner}
		</div>
	);
}

function ClockIcon(): React.ReactNode {
	return (
		<svg
			width={14}
			height={14}
			viewBox="0 0 24 24"
			fill="none"
			stroke="var(--sqlnest-text-cream)"
			strokeWidth={2}
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<title>Recents</title>
			<circle cx={12} cy={12} r={9} />
			<path d="M12 7v5l3 2" />
		</svg>
	);
}

function CanvasIcon(): React.ReactNode {
	return (
		<svg
			width={14}
			height={14}
			viewBox="0 0 24 24"
			fill="none"
			stroke="var(--sqlnest-text-cream)"
			strokeWidth={2}
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<title>Canvas</title>
			<rect x={3} y={3} width={18} height={18} rx={2} />
			<path d="M3 9h18" />
			<path d="M9 21V9" />
		</svg>
	);
}

function BookmarkIcon(): React.ReactNode {
	return (
		<svg
			width={14}
			height={14}
			viewBox="0 0 24 24"
			fill="none"
			stroke="var(--sqlnest-text-cream)"
			strokeWidth={2}
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<title>Saved Queries</title>
			<path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
		</svg>
	);
}

function TestIcon(): React.ReactNode {
	return (
		<svg
			width={14}
			height={14}
			viewBox="0 0 24 24"
			fill="none"
			stroke="var(--sqlnest-text-cream)"
			strokeWidth={2}
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<title>Tests</title>
			<path d="M9 3v6l-5 9a2 2 0 0 0 2 3h12a2 2 0 0 0 2-3l-5-9V3" />
			<path d="M8 3h8" />
		</svg>
	);
}
