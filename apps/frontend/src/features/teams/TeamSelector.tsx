/**
 * Sélecteur team pour la sidebar gallery (C.21.6, refactor Figma-like).
 *
 * Rendu compact : logo carré + nom + chevron + badge plan (V1 = "Free").
 * Clic → dropdown avec l'unique team surlignée + « Nouvelle team »
 * disabled (V2). Ferme au clic outside / Escape.
 *
 * ─── Décisions UX ────────────────────────────────────────────────────
 * - Le trigger est un bouton PLEIN (pas d'inline avec le container) —
 *   au hover, léger surface-hover pour signaler l'interactivité.
 * - Le nom déborde en ellipsis quand long (emails de team en attendant
 *   des noms courts). Titre HTML pour tooltip natif.
 * - Le badge « Free » est décoratif (V1 pas de billing) — reste visible
 *   pour préparer la V2 pricing tiers.
 * - Menu absolu positionné SOUS le trigger, background solide
 *   `--sqlnest-elevated` pour ressortir contre la sidebar (bug de
 *   layering précédent : var undefined = transparent = illisible).
 */

import { Link } from "@tanstack/react-router";
import { type CSSProperties, useEffect, useRef, useState } from "react";
import type { TeamContext } from "./useCurrentTeam";
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
	background: "transparent",
	border: "none",
	borderRadius: 6,
	cursor: "pointer",
	textAlign: "left",
	color: "var(--sqlnest-text-primary)",
	font: "inherit",
	minWidth: 0
};

// Avatar rond sobre — sera remplacé par une image profil quand
// l'user en aura une (params compte, à venir).
const avatarStyle: CSSProperties = {
	width: 22,
	height: 22,
	borderRadius: "50%",
	background: "var(--sqlnest-surface-hover)",
	border: "1px solid var(--sqlnest-border-subtle)",
	display: "flex",
	alignItems: "center",
	justifyContent: "center",
	fontWeight: 600,
	fontSize: 11,
	color: "var(--sqlnest-text-primary)",
	flexShrink: 0
};

const nameStyle: CSSProperties = {
	fontSize: 12.5,
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
	fontSize: 12.5,
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
	font: "inherit"
};

const menuItemActive: CSSProperties = {
	...menuItemBase,
	background: "var(--sqlnest-accent-soft)",
	color: "var(--sqlnest-text-primary)"
};

const menuItemDisabled: CSSProperties = {
	...menuItemBase,
	color: "var(--sqlnest-text-tertiary)",
	cursor: "not-allowed"
};

export interface TeamSelectorProps {
	readonly currentTeam: TeamContext;
}

export function TeamSelector({ currentTeam }: TeamSelectorProps) {
	const [open, setOpen] = useState(false);
	const containerRef = useRef<HTMLDivElement>(null);
	const { data: teams } = useMyTeams();

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
	const shortName = shortenName(currentTeam.name);

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
				<span style={avatarStyle}>{initialOf(currentTeam.name)}</span>
				<span style={nameStyle} title={currentTeam.name}>
					{shortName}
				</span>
				<span style={badgeStyle}>Free</span>
				<Chevron open={open} />
			</button>

			{open ? (
				<div style={menuStyle} role="menu">
					{displayTeams.map((t) => {
						const isActive = t.slug === currentTeam.slug;
						if (isActive) {
							return (
								<div
									key={t.id}
									style={menuItemActive}
									role="menuitem"
									aria-current={true}
									title={t.name}
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
										{shortenName(t.name)}
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
								role="menuitem"
								title={t.name}
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
									{shortenName(t.name)}
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
						style={menuItemDisabled}
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

/** Raccourci un nom trop long en gardant la partie avant `@` (emails
 *  de team) — évite d'afficher `anthonincolas@gmail.com` en entier. */
function shortenName(name: string): string {
	const trimmed = name.trim();
	if (!trimmed) return "Team";
	const atIdx = trimmed.indexOf("@");
	if (atIdx > 0) return trimmed.slice(0, atIdx);
	return trimmed;
}

function initialOf(name: string): string {
	const short = shortenName(name);
	return (short.charAt(0) || "T").toUpperCase();
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
