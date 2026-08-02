import { Button } from "@sqlnest/design-system";
import { IconBrandGithub, IconBrandGoogle } from "@tabler/icons-react";
import { type CSSProperties, useState } from "react";
import { signIn } from "./authClient";
import { isSafeCallback } from "./isSafe";

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

	// Defense-in-depth : si l'appelant passe une URL non same-origin, on
	// retombe sur "/". Le premier filet est `validateSearch` de `/login`.
	const safeCallback = isSafeCallback(callbackURL) ? callbackURL : "/";

	const handleClick = async (provider: OAuthProvider) => {
		setLoading(provider);
		try {
			// `signIn.social` déclenche un `window.location` vers le provider —
			// pas besoin de gérer navigate() côté React, ni d'invalider la
			// session (le callback OAuth atterrit sur `callbackURL` avec cookie
			// déjà posé, et le beforeLoad du layout `_authenticated` refetch
			// la session).
			await signIn.social({ provider, callbackURL: safeCallback });
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
			</div>
		</div>
	);
}
