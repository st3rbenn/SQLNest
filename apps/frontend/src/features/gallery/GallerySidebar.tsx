import { Link } from "@tanstack/react-router";
import type { CSSProperties } from "react";
import { UserBadge } from "../auth/UserBadge";
import { TeamSelector } from "../teams/TeamSelector";
import { useCurrentTeam } from "../teams/useCurrentTeam";

/**
 * Sidebar partagée entre la gallery (`/team/:slug`, `/team/:slug/recents`)
 * et la page de pairing (`/team/:slug/pair`). 2 blocs :
 *   1. Perso — UserBadge + nav cross-team (Recents)
 *   2. Team  — TeamSelector + nav team-scoped (Drafts)
 * Footer : CTA « Nouveau canvas » qui pointe vers `/pair`. Marqué actif
 * quand `activeItem === "pair"` (utilisateur EST sur la page pairing).
 */

const sidebarStyle: CSSProperties = {
	width: 260,
	background: "var(--sqlnest-surface)",
	borderRight: "1px solid var(--sqlnest-border)",
	display: "flex",
	flexDirection: "column",
	flexShrink: 0
};

export type SidebarActiveItem = "recents" | "drafts" | "pair";

export function GallerySidebar({
	teamSlug,
	hasConnections,
	activeItem
}: {
	readonly teamSlug: string | null;
	readonly hasConnections: boolean;
	readonly activeItem?: SidebarActiveItem;
}): React.ReactNode {
	const team = useCurrentTeam();
	return (
		<aside style={sidebarStyle}>
			{/* ── Bloc PERSONAL : user + nav cross-team. ──────────────── */}
			<div style={{ padding: "8px 12px 4px" }}>
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
			<div style={{ padding: "2px 12px" }}>
				{teamSlug ? (
					<NavItem
						label="Drafts"
						icon={<DraftIcon />}
						active={activeItem === "drafts"}
						to="/team/$teamSlug"
						params={{ teamSlug }}
					/>
				) : (
					<NavItem label="Drafts" icon={<DraftIcon />} active={false} />
				)}
			</div>

			<div style={{ flex: 1 }} />

			<div style={{ padding: "10px 10px 12px" }}>
				<PairCta
					teamSlug={teamSlug}
					hasConnections={hasConnections}
					active={activeItem === "pair"}
				/>
			</div>
		</aside>
	);
}

function PairCta({
	teamSlug,
	hasConnections,
	active
}: {
	readonly teamSlug: string | null;
	readonly hasConnections: boolean;
	readonly active: boolean;
}): React.ReactNode {
	const className = active
		? "sqlnest-sidebar-item sqlnest-sidebar-item--active"
		: "sqlnest-sidebar-item";
	const style: CSSProperties = {
		display: "flex",
		width: "100%",
		alignItems: "center",
		gap: 7,
		padding: "6px 10px",
		color: "var(--sqlnest-text-secondary)",
		borderRadius: 6,
		fontSize: 12,
		textDecoration: "none",
		boxSizing: "border-box"
	};
	const inner = (
		<>
			<svg
				width={12}
				height={12}
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth={2}
				aria-hidden="true"
			>
				<title>Nouveau canvas</title>
				<path d="M12 5v14M5 12h14" />
			</svg>
			<span style={{ flex: 1 }}>Nouveau canvas</span>
			{hasConnections ? (
				<span
					title="Au moins une connection"
					style={{
						width: 5,
						height: 5,
						borderRadius: "50%",
						background: "var(--sqlnest-success)"
					}}
				/>
			) : null}
		</>
	);
	if (teamSlug) {
		return (
			<Link
				to="/team/$teamSlug/pair"
				params={{ teamSlug }}
				className={className}
				style={style}
			>
				{inner}
			</Link>
		);
	}
	return (
		<Link to="/pair" className={className} style={style}>
			{inner}
		</Link>
	);
}

function NavItem({
	label,
	icon,
	active,
	to,
	params
}: {
	readonly label: string;
	readonly icon: React.ReactNode;
	readonly active: boolean;
	readonly to?: "/team/$teamSlug" | "/team/$teamSlug/recents";
	readonly params?: { readonly teamSlug: string };
}): React.ReactNode {
	const className = active
		? "sqlnest-sidebar-item sqlnest-sidebar-item--active"
		: "sqlnest-sidebar-item";
	const style: CSSProperties = {
		display: "flex",
		alignItems: "center",
		gap: 10,
		padding: "6px 8px",
		color: "var(--sqlnest-text-title)",
		borderRadius: 6,
		fontSize: 12,
		fontWeight: 500,
		cursor: to ? "pointer" : "default",
		textDecoration: "none"
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
		</>
	);
	if (to && params) {
		return (
			<Link to={to} params={params} className={className} style={style}>
				{inner}
			</Link>
		);
	}
	return (
		<div className={className} style={style}>
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

function DraftIcon(): React.ReactNode {
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
			<title>Drafts</title>
			<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
			<path d="M14 3v5h5" />
		</svg>
	);
}
