import { ActionIcon, Avatar, Menu } from "@mantine/core";
import { IconArrowLeft } from "@tabler/icons-react";
import { Link, useLocation } from "@tanstack/react-router";
import type { CSSProperties } from "react";
import { useCurrentUser } from "./sessionQuery";

/**
 * Allowlist des hosts d'images OAuth. `user.image` vient de Google / GitHub
 * (via Better Auth OAuth), donc contrôlé — mais un jour un provider pourrait
 * renvoyer une URL vers un CDN tiers qu'on ne veut pas fetch (tracking
 * pixel, fingerprinting). On garde une allowlist stricte.
 */
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

const wrapperStyle: CSSProperties = {
	position: "fixed",
	top: 12,
	right: 12,
	zIndex: 10
};

/**
 * Menu utilisateur (avatar top-right). Trigger = avatar circulaire ; le
 * dropdown suit le style dark Figma (bg surface, hover subtle, séparateurs
 * légers).
 *
 * Contenu : "Retour aux canvas" (Link → `/`, sert de sortie depuis le
 * canvas courant). Email et déconnexion volontairement absents — pas de
 * multi-user pour l'instant.
 */
export function UserMenu() {
	const { data: session } = useCurrentUser();
	const location = useLocation();

	if (!session?.user) return null;
	// Sur la gallery `/`, `/team/:slug`, `/team/:slug/recents` OU
	// `/team/:slug/pair`, la sidebar affiche déjà un `UserBadge` — on
	// cache le trigger flottant pour éviter le doublon UX. Sur les pages
	// sans sidebar (canvas, query), UserMenu reste le seul accès au menu
	// compte.
	if (location.pathname === "/") return null;
	if (/^\/team\/[0-9a-f]{6}(\/(recents|pair))?\/?$/.test(location.pathname)) {
		return null;
	}

	const user = session.user;
	const displayName = user.name?.trim() || user.email;
	const initial = displayName.charAt(0).toUpperCase();

	return (
		<div style={wrapperStyle}>
			<Menu
				shadow="md"
				width={168}
				position="bottom-end"
				withArrow={false}
				offset={6}
				radius={8}
				styles={{
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
				}}
			>
				<Menu.Target>
					<ActionIcon
						variant="subtle"
						size={32}
						radius="xl"
						aria-label={`Menu de ${displayName}`}
					>
						<Avatar
							src={safeAvatarSrc(user.image)}
							alt={displayName}
							radius="xl"
							size={28}
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
		</div>
	);
}
