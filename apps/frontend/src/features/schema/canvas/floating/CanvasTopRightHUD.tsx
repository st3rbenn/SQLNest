import { ActionIcon, Avatar, Menu, UnstyledButton } from "@mantine/core";
import { IconArrowLeft, IconChevronDown } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { useReactFlow, useViewport } from "@xyflow/react";
import type { CSSProperties } from "react";
import { useCurrentUser } from "../../../auth/sessionQuery";

/**
 * HUD flottant top-right du canvas — regroupe l'accès compte (avatar +
 * dropdown) et le contrôle de zoom dans un seul container élevé pour
 * ne pas encombrer visuellement le canvas.
 *
 * Contenu :
 *   - Avatar user → dropdown : « Retour aux canvas », plus tard settings.
 *   - Indicateur `<zoom>%` → dropdown : Zoom in/out, Fit, presets 50/100/200%.
 *     Le pourcentage est réactif via `useViewport()` de React Flow.
 *
 * Doit être monté DANS `<ReactFlow>` (typiquement via `<Panel position="top-right">`)
 * pour que `useViewport` et `useReactFlow` fonctionnent. L'UserMenu global
 * flottant est caché sur les routes canvas — voir `UserMenu.tsx`.
 */

const containerStyle: CSSProperties = {
	display: "flex",
	alignItems: "center",
	gap: 6,
	padding: 7,
	background: "var(--sqlnest-elevated)",
	border: "1px solid var(--sqlnest-border-subtle)",
	borderRadius: 10,
	boxShadow: "var(--sqlnest-shadow-floating)"
};

const zoomTriggerStyle: CSSProperties = {
	display: "inline-flex",
	alignItems: "center",
	gap: 4,
	padding: "5px 8px",
	borderRadius: 6,
	color: "var(--sqlnest-text-primary)",
	fontSize: 12,
	fontWeight: 500,
	fontVariantNumeric: "tabular-nums",
	// Largeur min pour éviter que le trigger « saute » entre 80% / 100%.
	minWidth: 58,
	justifyContent: "space-between"
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

/** Hover state via la classe DS `sqlnest-menu-item` (tokens.css) —
 *  Mantine ne fournit pas de hover natif visible en dark sur ses items
 *  Menu, on prend le nôtre. */
const menuClassNames = {
	item: "sqlnest-menu-item"
} as const;

/** Allowlist stricte des hosts OAuth pour éviter fetch d'un CDN tiers.
 *  Identique à `UserMenu.tsx` — dupliqué ici pour rester local, à
 *  factoriser si un 3e consumer apparaît. */
const AVATAR_HOST_RE =
	/^(lh[3-6]\.googleusercontent\.com|avatars\.githubusercontent\.com)$/;

function safeAvatarSrc(v: unknown): string | null {
	if (typeof v !== "string" || v.length === 0) return null;
	try {
		const u = new URL(v);
		if (u.protocol !== "https:") return null;
		if (!AVATAR_HOST_RE.test(u.hostname)) return null;
		return u.toString();
	} catch {
		return null;
	}
}

const ZOOM_PRESETS = [0.5, 1, 2] as const;

export function CanvasTopRightHUD(): React.ReactNode {
	return (
		<div style={containerStyle}>
			<UserAvatarMenu />
			<ZoomControl />
		</div>
	);
}

function UserAvatarMenu(): React.ReactNode {
	const { data: session } = useCurrentUser();
	if (!session?.user) return null;
	const user = session.user;
	const displayName = user.name?.trim() || user.email;
	const initial = displayName.charAt(0).toUpperCase();
	return (
		<Menu
			shadow="md"
			width={168}
			position="bottom-end"
			withArrow={false}
			offset={8}
			radius={8}
			transitionProps={{ duration: 0 }}
			styles={menuStyles}
			classNames={menuClassNames}
		>
			<Menu.Target>
				<ActionIcon
					variant="subtle"
					size={28}
					radius="xl"
					aria-label={`Menu de ${displayName}`}
				>
					<Avatar
						src={safeAvatarSrc(user.image)}
						alt={displayName}
						radius="xl"
						size={24}
						color="blue"
					>
						{initial}
					</Avatar>
				</ActionIcon>
			</Menu.Target>
			<Menu.Dropdown>
				<Menu.Item
					component={Link}
					to="/"
					leftSection={<IconArrowLeft size={13} stroke={2} />}
				>
					Retour aux canvas
				</Menu.Item>
			</Menu.Dropdown>
		</Menu>
	);
}

function ZoomControl(): React.ReactNode {
	const { zoom } = useViewport();
	const { zoomIn, zoomOut, zoomTo, fitView } = useReactFlow();
	const percent = Math.round(zoom * 100);
	return (
		<Menu
			shadow="md"
			width={172}
			position="bottom-end"
			withArrow={false}
			offset={8}
			radius={8}
			transitionProps={{ duration: 0 }}
			styles={menuStyles}
			classNames={menuClassNames}
		>
			<Menu.Target>
				<UnstyledButton
					aria-label={`Zoom ${percent}% — cliquer pour changer`}
					style={zoomTriggerStyle}
				>
					<span>{percent}%</span>
					<IconChevronDown size={12} stroke={2} aria-hidden />
				</UnstyledButton>
			</Menu.Target>
			<Menu.Dropdown>
				<Menu.Item onClick={() => zoomIn()} rightSection="⌘+">
					Zoom in
				</Menu.Item>
				<Menu.Item onClick={() => zoomOut()} rightSection="⌘−">
					Zoom out
				</Menu.Item>
				<Menu.Item onClick={() => fitView({ padding: 0.2 })} rightSection="⇧1">
					Adapter à la fenêtre
				</Menu.Item>
				<Menu.Divider />
				{ZOOM_PRESETS.map((preset) => (
					<Menu.Item key={preset} onClick={() => zoomTo(preset)}>
						Zoom à {Math.round(preset * 100)}%
					</Menu.Item>
				))}
			</Menu.Dropdown>
		</Menu>
	);
}
