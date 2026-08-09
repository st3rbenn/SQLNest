import { Avatar, Menu, Tooltip, UnstyledButton } from "@mantine/core";
import { useHotkeys } from "@mantine/hooks";
import { IconChevronDown, IconTerminal2 } from "@tabler/icons-react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useReactFlow, useViewport } from "@xyflow/react";
import type { CSSProperties } from "react";
import { useCurrentUser } from "../../../auth/sessionQuery";
import { openConsoleInPopout } from "../../../query/usePopoutWindow";

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
			<ConsoleButton />
			<ZoomControl />
		</div>
	);
}

/**
 * Ouvre la console SNQL fullscreen sur la route `/query`. Raccourcis :
 *   ⌘K  → navigate même onglet
 *   ⇧⌘K → détache dans une fenêtre pop-out (2ᵉ écran)
 *
 * Rendu comme icône dans le HUD. Les params team/conn viennent de la
 * route parente — le HUD n'est monté qu'à l'intérieur du canvas.
 */
function ConsoleButton(): React.ReactNode {
	const params = useParams({
		from: "/_authenticated/team/$teamSlug/canvas/$connId/"
	}) as { teamSlug: string; connId: string };
	const navigate = useNavigate();

	function openFullscreen(): void {
		navigate({
			to: "/team/$teamSlug/canvas/$connId/query",
			params: { teamSlug: params.teamSlug, connId: params.connId }
		});
	}

	function openPopout(): void {
		openConsoleInPopout(params.teamSlug, params.connId);
	}

	// 2ᵉ arg [] = actif même dans les inputs. Le canvas ReactFlow n'est
	// pas un input, mais l'user peut avoir focus dans un search / rename.
	useHotkeys(
		[
			["mod+K", openFullscreen, { preventDefault: true }],
			["mod+shift+K", openPopout, { preventDefault: true }]
		],
		[]
	);

	return (
		<Tooltip
			label="Console SNQL — ⌘K (ou ⇧⌘K pour détacher)"
			openDelay={400}
			styles={{
				tooltip: { fontSize: 11, padding: "4px 8px", borderRadius: 6 }
			}}
			withArrow
			arrowSize={4}
		>
			<UnstyledButton
				aria-label="Ouvrir la console SNQL"
				className="sqlnest-menu-item"
				onClick={openFullscreen}
				style={{
					display: "inline-flex",
					alignItems: "center",
					justifyContent: "center",
					width: 28,
					height: 28,
					borderRadius: 6,
					color: "var(--sqlnest-text-primary)"
				}}
			>
				<IconTerminal2 size={15} stroke={2} />
			</UnstyledButton>
		</Tooltip>
	);
}

/** Avatar display-only — le dropdown historique (« Retour aux canvas »)
 *  a été retiré, à remplacer par un menu compte plus complet. */
function UserAvatarMenu(): React.ReactNode {
	const { data: session } = useCurrentUser();
	if (!session?.user) return null;
	const user = session.user;
	const displayName = user.name?.trim() || user.email;
	const initial = displayName.charAt(0).toUpperCase();
	return (
		<span
			aria-label={displayName}
			style={{
				display: "inline-flex",
				alignItems: "center",
				justifyContent: "center"
			}}
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
		</span>
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
					className="sqlnest-menu-item"
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
