import { PasswordInput, TextInput } from "@mantine/core";
import { Button } from "@sqlnest/design-system";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { type CSSProperties, type FormEvent, useState } from "react";
import { isSafePath, Route as LoginRoute } from "../../routes/_auth.login";
import { signIn } from "./authClient";
import { DismissibleAlert } from "./DismissibleAlert";
import { OAuthButtons } from "./OAuthButtons";
import { sessionQueryOptions } from "./sessionQuery";

const titleStyle: CSSProperties = {
	fontSize: 20,
	fontWeight: 600,
	color: "var(--sqlnest-text-primary)",
	margin: "0 0 6px"
};

const subtitleStyle: CSSProperties = {
	fontSize: 13,
	color: "var(--sqlnest-text-secondary)",
	margin: "0 0 20px"
};

const formStyle: CSSProperties = {
	display: "flex",
	flexDirection: "column",
	gap: 14
};

const footerStyle: CSSProperties = {
	marginTop: 20,
	fontSize: 13,
	color: "var(--sqlnest-text-secondary)",
	textAlign: "center"
};

const linkStyle: CSSProperties = {
	color: "var(--sqlnest-accent)",
	textDecoration: "none"
};

const forgotStyle: CSSProperties = {
	fontSize: 12,
	color: "var(--sqlnest-text-tertiary)",
	textDecoration: "none",
	alignSelf: "flex-end",
	marginTop: -8
};

/**
 * Page /login.
 *
 * Contrat :
 * - `search.redirect` (posé par `_authenticated` guard) → destination post-login.
 * - Submit email/password : `signIn.email(...)` → succès → invalidate session
 *   → `navigate(redirect ?? "/")`.
 * - Erreur : Alert générique **sans** distinguer "email inconnu" vs "mauvais mot
 *   de passe" (enumeration-safe côté UI, même si Better Auth le fait déjà côté
 *   backend). On relaie juste le message.
 * - OAuth : `<OAuthButtons callbackURL={redirect ?? "/"} />`.
 */
export function LoginPage() {
	const search = LoginRoute.useSearch();
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [isSubmitting, setIsSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// Defense-in-depth : `validateSearch` de `/login` filtre déjà via
	// isSafePath, mais on re-check ici avant tout `navigate` / propagation
	// vers OAuthButtons (protection open redirect).
	const redirectTo = isSafePath(search.redirect) ? search.redirect : "/";

	const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
		e.preventDefault();
		setError(null);
		setIsSubmitting(true);
		// Better Auth renvoie `{ data, error }` — on ne throw pas.
		const result = await signIn.email({ email, password });
		if (result.error) {
			setError(result.error.message ?? "Email ou mot de passe invalide.");
			setIsSubmitting(false);
			return;
		}
		// Session posée côté backend (cookie Set-Cookie de la réponse). On
		// force un REFETCH (fetchQuery, pas invalidateQueries) : sur cette
		// page il n'y a aucun observer actif sur AUTH_SESSION_QUERY_KEY,
		// donc invalidateQueries marque juste stale sans refetch — puis
		// beforeLoad(_authenticated) sert le cache stale (null) → redirect
		// /login → boucle. fetchQuery force le fetch et met en cache la
		// nouvelle session AVANT le navigate.
		await queryClient.fetchQuery(sessionQueryOptions());
		void navigate({ to: redirectTo });
	};

	return (
		<div>
			<h2 style={titleStyle}>Se connecter</h2>
			<p style={subtitleStyle}>Ravi de te revoir.</p>

			{error ? (
				<DismissibleAlert
					color="red"
					variant="light"
					mb="md"
					title="Connexion refusée"
					onDismiss={() => setError(null)}
				>
					{error}
				</DismissibleAlert>
			) : null}

			<form style={formStyle} onSubmit={handleSubmit} noValidate>
				<TextInput
					label="Email"
					type="email"
					value={email}
					onChange={(e) => setEmail(e.currentTarget.value)}
					autoComplete="off"
					required
					disabled={isSubmitting}
					autoFocus
				/>
				<PasswordInput
					label="Mot de passe"
					value={password}
					onChange={(e) => setPassword(e.currentTarget.value)}
					autoComplete="off"
					required
					disabled={isSubmitting}
				/>
				<Link to="/forgot-password" style={forgotStyle}>
					Mot de passe oublié ?
				</Link>
				<Button
					type="submit"
					loading={isSubmitting}
					loadingLabel="Connexion…"
					disabled={email.trim() === "" || password === ""}
				>
					Se connecter
				</Button>
			</form>

			<OAuthButtons callbackURL={redirectTo} />

			<div style={footerStyle}>
				Pas de compte ?{" "}
				<Link to="/signup" style={linkStyle}>
					Créer un compte
				</Link>
			</div>
		</div>
	);
}
