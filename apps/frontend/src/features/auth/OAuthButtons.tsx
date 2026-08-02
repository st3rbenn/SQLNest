import { Button, showNotification } from "@sqlnest/design-system";
import { IconBrandGithub, IconBrandGoogle } from "@tabler/icons-react";
import { type CSSProperties, useState } from "react";
import { signIn } from "./authClient";
import { isSafeCallback } from "./isSafe";
import { useOAuthProviders } from "./useOAuthProviders";

/**
 * Boutons OAuth Google + GitHub.
 *
 * V1 : on affiche les deux inconditionnellement — le backend décide
 * d'accepter/refuser selon la présence des env vars `GOOGLE_CLIENT_ID` /
 * `GITHUB_CLIENT_ID` (cf. `03-auth.plugin.ts`). Un provider non configuré
 * renvoie une erreur Better Auth que l'utilisateur verra sur la page
 * providers. À court terme, on pourra exposer un `/api/auth/get-providers`
 * pour ne rendre que les providers dispos — pour l'instant on privilégie
 * la simplicité et une UX à 2 boutons cohérente sur `/login` + `/signup`.
 *
 * `callbackURL` : chemin interne où renvoyer après OAuth. Validé côté
 * composant (defense-in-depth : la validateSearch de `/login` filtre déjà,
 * mais on re-check pour éviter qu'un appelant passe une URL absolue).
 * Défaut `/` (canvas).
 */
export interface OAuthButtonsProps {
	callbackURL?: string;
}

const containerStyle: CSSProperties = {
	display: "flex",
	flexDirection: "column",
	gap: 8,
	marginTop: 16
};

const dividerStyle: CSSProperties = {
	display: "flex",
	alignItems: "center",
	gap: 12,
	margin: "20px 0 12px",
	color: "var(--sqlnest-text-tertiary)",
	fontSize: 12
};

const dividerLineStyle: CSSProperties = {
	flex: 1,
	height: 1,
	background: "var(--sqlnest-border)"
};

type OAuthProvider = "google" | "github";

export function OAuthButtons({ callbackURL = "/" }: OAuthButtonsProps) {
	const [loading, setLoading] = useState<OAuthProvider | null>(null);
	const providers = useOAuthProviders();

	// Si AUCUN provider n'est configuré (env vars absentes backend, ou
	// backend HS), on n'affiche RIEN — pas de séparateur "ou avec", pas
	// de boutons cliqués dans le vide.
	if (!providers.google && !providers.github) return null;

	// Defense-in-depth : si l'appelant passe une URL non same-origin, on
	// retombe sur "/". Le premier filet est `validateSearch` de `/login`.
	const safeCallback = isSafeCallback(callbackURL) ? callbackURL : "/";

	const handleClick = async (provider: OAuthProvider) => {
		setLoading(provider);
		try {
			// `signIn.social` déclenche un `window.location` vers le provider —
			// dans le happy path, la page navigue et ce composant est unmounté
			// avant que le `finally` s'exécute. Si `signIn.social` retourne
			// une erreur (provider non configuré backend, réseau, config
			// invalide) sans faire de window.location, la page reste montée
			// et l'user ne voit RIEN → cliquer 3× sans feedback. On surface
			// l'erreur via notification.
			const result = await signIn.social({
				provider,
				callbackURL: safeCallback
			});
			if (result?.error) {
				showNotification({
					title:
						provider === "google"
							? "Connexion Google indisponible"
							: "Connexion GitHub indisponible",
					message:
						result.error.message ??
						"Ce provider n'est pas configuré côté serveur.",
					color: "red",
					autoClose: 5000
				});
			}
		} catch (err) {
			// Erreur réseau ou throw inattendu → surface aussi.
			showNotification({
				title: "Erreur de connexion",
				message:
					err instanceof Error ? err.message : "Réessaie dans un instant.",
				color: "red",
				autoClose: 5000
			});
		} finally {
			setLoading(null);
		}
	};

	const isBusy = loading !== null;

	return (
		<div>
			<div style={dividerStyle}>
				<div style={dividerLineStyle} />
				<span>ou avec</span>
				<div style={dividerLineStyle} />
			</div>
			<div style={containerStyle}>
				{providers.google ? (
					<Button
						variant="secondary"
						fullWidth
						leftSection={<IconBrandGoogle size={16} />}
						loading={loading === "google"}
						loadingLabel="Redirection…"
						disabled={isBusy}
						onClick={() => {
							void handleClick("google");
						}}
					>
						Continuer avec Google
					</Button>
				) : null}
				{providers.github ? (
					<Button
						variant="secondary"
						fullWidth
						leftSection={<IconBrandGithub size={16} />}
						loading={loading === "github"}
						loadingLabel="Redirection…"
						disabled={isBusy}
						onClick={() => {
							void handleClick("github");
						}}
					>
						Continuer avec GitHub
					</Button>
				) : null}
			</div>
		</div>
	);
}
