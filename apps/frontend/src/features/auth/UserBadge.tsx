/**
 * UserBadge — bloc user en top de la sidebar gallery (C.21 refactor).
 *
 * Miroir du menu Figma / Notion "workspace switcher > user" en top-left :
 * avatar rond + nom + chevron. Ouvre un dropdown compact avec les
 * actions du compte (settings, logout).
 *
 * V1 propose uniquement « Se déconnecter » — les autres items existent
 * en placeholder (Paramètres, image profil) prêts pour V2.
 *
 * Styles hover / active portés par les classes DS `sqlnest-sidebar-item`
 * + `sqlnest-menu-item` (tokens.css).
 */

import { type CSSProperties, useEffect, useRef, useState } from "react";
import { signOut } from "./authClient";
import { useCurrentUser } from "./sessionQuery";

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
	border: "none",
	borderRadius: 6,
	cursor: "pointer",
	textAlign: "left",
	color: "var(--sqlnest-text-primary)",
	fontFamily: "inherit",
	fontSize: 12,
	minWidth: 0
};

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
	border: "none",
	width: "100%",
	textAlign: "left",
	fontFamily: "inherit"
};

export function UserBadge() {
	const { data: session } = useCurrentUser();
	const [open, setOpen] = useState(false);
	const containerRef = useRef<HTMLDivElement>(null);

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

	if (!session?.user) return null;
	const user = session.user;
	const displayName = shortenName(user.name || user.email);
	const initial = (displayName.charAt(0) || "U").toUpperCase();

	async function handleLogout(): Promise<void> {
		setOpen(false);
		await signOut();
		// Better Auth ne redirige pas automatiquement — force un reload vers
		// /login pour reset le queryClient + les query caches.
		window.location.assign("/login");
	}

	return (
		<div ref={containerRef} style={containerStyle}>
			<button
				type="button"
				onClick={() => setOpen((v) => !v)}
				style={triggerStyle}
				className="sqlnest-sidebar-item"
				aria-expanded={open}
				aria-haspopup="menu"
				data-testid="user-badge-trigger"
			>
				<span style={avatarStyle}>{initial}</span>
				<span style={nameStyle} title={user.name || user.email}>
					{displayName}
				</span>
				<Chevron open={open} />
			</button>

			{open ? (
				<div style={menuStyle} role="menu">
					<div
						style={{
							padding: "8px 8px 6px",
							fontSize: 11,
							color: "var(--sqlnest-text-tertiary)",
							whiteSpace: "nowrap",
							overflow: "hidden",
							textOverflow: "ellipsis"
						}}
						title={user.email}
					>
						{user.email}
					</div>
					<div
						style={{
							height: 1,
							background: "var(--sqlnest-border-subtle)",
							margin: "2px 0 4px"
						}}
					/>
					<button
						type="button"
						style={menuItemBase}
						className="sqlnest-menu-item"
						disabled
						title="Bientôt : paramètres du compte + avatar"
						role="menuitem"
					>
						<span style={{ flex: 1 }}>Paramètres</span>
						<span
							style={{
								fontSize: 10,
								color: "var(--sqlnest-text-tertiary)"
							}}
						>
							bientôt
						</span>
					</button>
					<button
						type="button"
						style={menuItemBase}
						className="sqlnest-menu-item"
						onClick={handleLogout}
						role="menuitem"
						data-testid="user-badge-logout"
					>
						<span style={{ flex: 1 }}>Se déconnecter</span>
					</button>
				</div>
			) : null}
		</div>
	);
}

function shortenName(name: string): string {
	const trimmed = name.trim();
	if (!trimmed) return "Compte";
	const atIdx = trimmed.indexOf("@");
	if (atIdx > 0) return trimmed.slice(0, atIdx);
	return trimmed;
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
