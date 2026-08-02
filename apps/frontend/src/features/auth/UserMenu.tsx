import { ActionIcon, Avatar, Menu, Text } from "@mantine/core";
import { showNotification } from "@sqlnest/design-system";
import { IconLogout } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { CSSProperties } from "react";
import { signOut } from "./authClient";
import { AUTH_SESSION_QUERY_KEY, useCurrentUser } from "./sessionQuery";

/**
 * Allowlist des hosts d'images OAuth. `user.image` vient de Google / GitHub
 * (via Better Auth OAuth), donc contrôlé — mais un jour un provider pourrait
 * renvoyer une URL vers un CDN tiers qu'on ne veut pas fetch (tracking
 * pixel, fingerprinting). On garde une allowlist stricte.
 *
 * Google sert les avatars via `lh3`/`lh4`/`lh5`/`lh6` (round-robin de
 * sous-domaines historiques, tous encore actifs — un user peut recevoir
 * n'importe lequel selon son compte). GitHub utilise un unique host.
 */
const AVATAR_HOST_RE = /^(lh[3-6]\.googleusercontent\.com|avatars\.githubusercontent\.com)$/;

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
 * Menu utilisateur (avatar top-right).
 *
 * Contrat :
 * - Monté DANS le layout `_authenticated` (garantit qu'on a une session).
 * - Trigger : `ActionIcon` circulaire qui wrap un `Avatar` (image `user.image`
 *   sinon initiales calculées depuis `name` ou `email`).
 * - Menu Mantine : header email, item disabled "Mes canvases (bientôt)",
 *   séparateur, item rouge "Se déconnecter".
 * - `handleSignOut` : `signOut()` → invalide `['auth','session']` → navigate
 *   `/login`. On invalide APRÈS signOut pour que le cookie soit vraiment
 *   supprimé côté backend avant que le beforeLoad du layout re-teste.
 */
export function UserMenu() {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const { data: session } = useCurrentUser();

	// Guard défensif — le layout `_authenticated` garantit `session !== null`,
	// mais entre invalidation et refetch il peut y avoir un flash de `null`.
	if (!session?.user) return null;

	const user = session.user;
	const displayName = user.name?.trim() || user.email;
	const initial = displayName.charAt(0).toUpperCase();

	const handleSignOut = async () => {
		const res = await signOut();
		if (res?.error) {
			// Le cookie n'a pas été supprimé côté backend (réseau, 500, …) —
			// on ne doit ni invalider (l'UI passerait à un état incohérent
			// "je suis sur /login mais toujours identifié") ni naviguer.
			showNotification({
				title: "Erreur",
				message: "Impossible de se déconnecter. Réessaie.",
				color: "red",
				autoClose: 5000
			});
			return;
		}
		// Invalide APRÈS que signOut ait supprimé le cookie côté backend —
		// sinon la refetch immédiate reverrait potentiellement une session
		// encore valide (race avec la propagation du Set-Cookie de suppression).
		await queryClient.invalidateQueries({ queryKey: AUTH_SESSION_QUERY_KEY });
		void navigate({ to: "/login" });
	};

	return (
		<div style={wrapperStyle}>
			<Menu shadow="md" width={220} position="bottom-end" withArrow>
				<Menu.Target>
					<ActionIcon
						variant="subtle"
						size={36}
						radius="xl"
						aria-label={`Menu de ${displayName}`}
					>
						<Avatar
							src={safeAvatarSrc(user.image)}
							alt={displayName}
							radius="xl"
							size={32}
							color="blue"
						>
							{initial}
						</Avatar>
					</ActionIcon>
				</Menu.Target>

				<Menu.Dropdown>
					<Menu.Label>
						<Text size="xs" c="dimmed" truncate>
							{user.email}
						</Text>
					</Menu.Label>
					<Menu.Item disabled>Mes canvases (bientôt)</Menu.Item>
					<Menu.Divider />
					<Menu.Item
						color="red"
						leftSection={<IconLogout size={14} />}
						onClick={handleSignOut}
					>
						Se déconnecter
					</Menu.Item>
				</Menu.Dropdown>
			</Menu>
		</div>
	);
}
