/**
 * Sélecteur team pour la sidebar gallery (C.21.6, refactor Figma-like).
 *
 * Rendu compact : logo carré + nom + chevron + badge plan (V1 = "Free").
 * Clic → dropdown avec l'unique team surlignée + « Nouvelle team »
 * disabled (V2). Ferme au clic outside / Escape.
 *
 * ─── Style ────────────────────────────────────────────────────────────
 * Hover / active / disabled états portés par les classes DS
 * `sqlnest-sidebar-item*` + `sqlnest-menu-item*` (tokens.css). Pas de
 * useState hover à la main.
 *
 * ─── Bug de layering précédent ────────────────────────────────────────
 * Le menu utilise `--sqlnest-elevated` (surface plus claire que la
 * sidebar) + z-index 100 pour ressortir sans transparence.
 */

import { Link } from "@tanstack/react-router";
import { type CSSProperties, useEffect, useRef, useState } from "react";
import { useCurrentUser } from "../auth/sessionQuery";
import { displayTeamName, type TeamContext } from "./useCurrentTeam";
import { useMyTeams } from "./useMyTeams";

const containerStyle: CSSProperties = {
	position: "relative",
	width: "100%"
};

const triggerStyle: CSSProperties = {
	display: "flex",
	alignItems: "center",
	gap: 10,
	padding: "6px 8px",
	width: "100%",
	// `background: transparent` explicite — sans ça le user-agent style
	// du <button> pose un gris par défaut. Le hover CSS (:hover
	// `!important` dans tokens.css) bat cette valeur inline.
	background: "transparent",
	border: "none",
	borderRadius: 6,
	cursor: "pointer",
	textAlign: "left",
	color: "var(--sqlnest-text-primary)",
	fontFamily: "inherit",
	fontSize: 12,
	minWidth: 0
};

// Avatar rond sobre — sera remplacé par une image profil quand
// l'user en aura une (params compte, à venir).
const avatarStyle: CSSProperties = {
	width: 20,
	height: 20,
	borderRadius: "50%",
	background: "var(--sqlnest-surface-hover)",
	border: "1px solid var(--sqlnest-border-subtle)",
	display: "flex",
	alignItems: "center",
	justifyContent: "center",
	fontWeight: 600,
	fontSize: 10.5,
	color: "var(--sqlnest-text-primary)",
	flexShrink: 0
};

const nameStyle: CSSProperties = {
	fontSize: 12,
	fontWeight: 600,
	flex: 1,
	minWidth: 0,
	whiteSpace: "nowrap",
	overflow: "hidden",
	textOverflow: "ellipsis"
};

const badgeStyle: CSSProperties = {
	fontSize: 10,
	fontWeight: 600,
	color: "var(--sqlnest-accent)",
	background: "var(--sqlnest-accent-soft)",
	padding: "1px 6px",
	borderRadius: 4,
	flexShrink: 0,
	letterSpacing: 0.2
};

const menuStyle: CSSProperties = {
	position: "absolute",
	top: "calc(100% + 4px)",
	left: 0,
	right: 0,
	background: "var(--sqlnest-elevated)",
	border: "1px solid var(--sqlnest-border-subtle)",
	borderRadius: 8,
	boxShadow: "0 12px 32px rgba(0, 0, 0, 0.45)",
	zIndex: 100,
	padding: 4
};

const menuItemBase: CSSProperties = {
	display: "flex",
	alignItems: "center",
	gap: 8,
	padding: "6px 8px",
	borderRadius: 4,
	fontSize: 12,
	color: "var(--sqlnest-text-secondary)",
	cursor: "pointer",
	textDecoration: "none",
	background: "transparent",
	border: "none",
	width: "100%",
	textAlign: "left",
	whiteSpace: "nowrap",
	overflow: "hidden",
	textOverflow: "ellipsis",
	fontFamily: "inherit"
};

export interface TeamSelectorProps {
	readonly currentTeam: TeamContext;
}

export function TeamSelector({ currentTeam }: TeamSelectorProps) {
	const [open, setOpen] = useState(false);
	const containerRef = useRef<HTMLDivElement>(null);
	const { data: teams } = useMyTeams();
	const { data: session } = useCurrentUser();
	const userName = session?.user?.name ?? null;

	useEffect(() => {
		if (!open) return;
		function onDoc(e: MouseEvent): void {
			if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
		}
		function onKey(e: KeyboardEvent): void {
			if (e.key === "Escape") setOpen(false);
		}
		document.addEventListener("mousedown", onDoc);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("mousedown", onDoc);
			document.removeEventListener("keydown", onKey);
		};
	}, [open]);

	const displayTeams = teams ?? [currentTeam];
	const currentDisplayName = displayTeamName(currentTeam, userName);

	return (
		<div ref={containerRef} style={containerStyle}>
			<button
				type="button"
				onClick={() => setOpen((v) => !v)}
				style={triggerStyle}
				className="sqlnest-sidebar-item"
				aria-expanded={open}
				aria-haspopup="menu"
				data-testid="team-selector-trigger"
			>
				<span style={avatarStyle}>{initialOf(currentDisplayName)}</span>
				<span style={nameStyle} title={currentDisplayName}>
					{currentDisplayName}
				</span>
				<span style={badgeStyle}>Free</span>
				<Chevron open={open} />
			</button>

			{open ? (
				<div style={menuStyle} role="menu">
					{displayTeams.map((t) => {
						const isActive = t.slug === currentTeam.slug;
						const label = displayTeamName(t, userName);
						if (isActive) {
							return (
								<div
									key={t.id}
									style={menuItemBase}
									className="sqlnest-menu-item sqlnest-menu-item--active"
									role="menuitem"
									aria-current={true}
									title={label}
								>
									<Dot />
									<span
										style={{
											flex: 1,
											minWidth: 0,
											overflow: "hidden",
											textOverflow: "ellipsis"
										}}
									>
										{label}
									</span>
								</div>
							);
						}
						return (
							<Link
								key={t.id}
								to="/team/$teamSlug"
								params={{ teamSlug: t.slug }}
								style={menuItemBase}
								className="sqlnest-menu-item"
								role="menuitem"
								title={label}
								onClick={() => setOpen(false)}
							>
								<span style={{ width: 6, flexShrink: 0 }} />
								<span
									style={{
										flex: 1,
										minWidth: 0,
										overflow: "hidden",
										textOverflow: "ellipsis"
									}}
								>
									{label}
								</span>
							</Link>
						);
					})}

					<div
						style={{
							height: 1,
							background: "var(--sqlnest-border-subtle)",
							margin: "4px 0"
						}}
					/>

					<button
						type="button"
						style={menuItemBase}
						className="sqlnest-menu-item"
						disabled
						title="Bientôt : créer une team pour inviter des collaborateurs"
						role="menuitem"
					>
						<span
							style={{
								width: 14,
								display: "inline-flex",
								justifyContent: "center",
								flexShrink: 0
							}}
						>
							+
						</span>
						<span style={{ flex: 1 }}>Nouvelle team</span>
						<span
							style={{
								fontSize: 10,
								color: "var(--sqlnest-text-tertiary)",
								flexShrink: 0
							}}
						>
							bientôt
						</span>
					</button>
				</div>
			) : null}
		</div>
	);
}

function initialOf(name: string): string {
	const trimmed = name.trim();
	if (!trimmed) return "T";
	return trimmed.charAt(0).toUpperCase();
}

function Chevron({ open }: { readonly open: boolean }): React.ReactNode {
	return (
		<svg
			width={10}
			height={10}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth={2.5}
			aria-hidden="true"
			style={{
				color: "var(--sqlnest-text-tertiary)",
				transform: open ? "rotate(180deg)" : undefined,
				transition: "transform 120ms ease",
				flexShrink: 0
			}}
		>
			<title>Ouvrir</title>
			<path d="M6 9l6 6 6-6" />
		</svg>
	);
}

function Dot(): React.ReactNode {
	return (
		<span
			style={{
				width: 6,
				height: 6,
				borderRadius: "50%",
				background: "var(--sqlnest-accent)",
				flexShrink: 0
			}}
			aria-hidden="true"
		/>
	);
}
