/**
 * Sélecteur team dans la sidebar gallery (C.21.6).
 *
 * V1 : chaque user a exactement UNE team perso — le dropdown affiche
 * juste son nom, ouvre un menu avec cette team (surlignée) + bouton
 * « Nouvelle team » disabled avec tooltip « bientôt ».
 *
 * V2 : le dropdown liste toutes les teams, permet de switcher (nav
 * `/team/:slug`), et le bouton « Nouvelle team » ouvrira un modal
 * de création.
 *
 * Comportement : click sur le trigger toggle l'ouverture. Click
 * outside ferme. Escape ferme. Focus visible sur le trigger.
 */

import { Link, useNavigate } from "@tanstack/react-router";
import { type CSSProperties, useEffect, useRef, useState } from "react";
import type { TeamContext } from "./useCurrentTeam";
import { useMyTeams } from "./useMyTeams";

const triggerStyle: CSSProperties = {
	display: "flex",
	alignItems: "center",
	gap: 8,
	padding: "6px 6px",
	width: "100%",
	background: "transparent",
	border: "none",
	borderRadius: 6,
	cursor: "pointer",
	textAlign: "left",
	color: "var(--sqlnest-text-primary)",
	font: "inherit"
};

const menuStyle: CSSProperties = {
	position: "absolute",
	top: "100%",
	left: 6,
	right: 6,
	marginTop: 4,
	background: "var(--sqlnest-elevated)",
	border: "1px solid var(--sqlnest-border-subtle)",
	borderRadius: 8,
	boxShadow: "0 8px 24px rgba(0, 0, 0, 0.2)",
	zIndex: 10,
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
	textAlign: "left"
};

const menuItemActive: CSSProperties = {
	...menuItemBase,
	background: "rgba(13, 153, 255, 0.12)",
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
	const navigate = useNavigate();
	const [open, setOpen] = useState(false);
	const containerRef = useRef<HTMLDivElement>(null);
	const { data: teams } = useMyTeams();

	// Click outside → ferme
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

	return (
		<div ref={containerRef} style={{ position: "relative" }}>
			<button
				type="button"
				onClick={() => setOpen((v) => !v)}
				style={triggerStyle}
				aria-expanded={open}
				aria-haspopup="menu"
				data-testid="team-selector-trigger"
			>
				<span
					style={{
						width: 22,
						height: 22,
						borderRadius: 6,
						background: "linear-gradient(135deg, #0D99FF, #6B4FE0)",
						display: "flex",
						alignItems: "center",
						justifyContent: "center",
						fontWeight: 700,
						fontSize: 11,
						color: "#fff",
						flexShrink: 0
					}}
				>
					{initialOf(currentTeam.name)}
				</span>
				<span
					style={{
						fontSize: 12.5,
						fontWeight: 600,
						flex: 1,
						minWidth: 0,
						whiteSpace: "nowrap",
						overflow: "hidden",
						textOverflow: "ellipsis"
					}}
					title={currentTeam.name}
				>
					{currentTeam.name}
				</span>
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
								>
									<Dot />
									<span style={{ flex: 1 }}>{t.name}</span>
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
								onClick={() => setOpen(false)}
							>
								<span style={{ width: 6 }} />
								<span style={{ flex: 1 }}>{t.name}</span>
							</Link>
						);
					})}

					<div
						style={{
							height: 1,
							background: "var(--sqlnest-border-subtle)",
							margin: "4px 6px"
						}}
					/>

					<button
						type="button"
						style={menuItemDisabled}
						disabled
						title="Bientôt : créer une team pour inviter des collaborateurs"
						role="menuitem"
					>
						<span style={{ width: 6 }}>+</span>
						<span style={{ flex: 1 }}>Nouvelle team</span>
						<span
							style={{
								fontSize: 10,
								color: "var(--sqlnest-text-tertiary)"
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
	if (!trimmed) return "S";
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
			strokeWidth={2}
			aria-hidden="true"
			style={{
				color: "var(--sqlnest-text-tertiary)",
				transform: open ? "rotate(180deg)" : undefined,
				transition: "transform 120ms ease"
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
