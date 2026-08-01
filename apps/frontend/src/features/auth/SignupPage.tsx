import { Alert, PasswordInput, TextInput } from "@mantine/core";
import { Button } from "@sqlnest/design-system";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { type CSSProperties, type FormEvent, useState } from "react";
import { signUp } from "./authClient";
import { OAuthButtons } from "./OAuthButtons";
import { AUTH_SESSION_QUERY_KEY } from "./sessionQuery";

const PASSWORD_ERROR_RE = /password/i;

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

/**
 * Page /signup.
 *
 * Contrat :
 * - Form : name (optionnel), email, password, confirm password.
 * - Backend a `autoSignIn: true` (cf. `03-auth.plugin.ts`) → session posée
 *   directement après `signUp.email(...)`. On invalide juste la query pour
 *   que l'UI voie l'utilisateur, puis on navigue vers `/`.
 * - Password ≠ confirm → erreur locale, on n'appelle pas le backend.
 * - Erreur backend : Alert (message générique — "Email déjà utilisé" ou autre
 *   retourné par Better Auth).
 */
export function SignupPage() {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const [name, setName] = useState("");
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [confirm, setConfirm] = useState("");
	const [isSubmitting, setIsSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const passwordsMismatch = confirm !== "" && confirm !== password;

	const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
		e.preventDefault();
		setError(null);
		if (password !== confirm) {
			setError("Les deux mots de passe ne correspondent pas.");
			return;
		}
		setIsSubmitting(true);
		// `name` est requis par Better Auth pour signUp.email — on passe
		// l'email comme fallback si l'utilisateur n'a rien saisi (le champ
		// est libellé optionnel côté UI, mais la contrainte backend reste).
		const result = await signUp.email({
			email,
			password,
			name: name.trim() !== "" ? name.trim() : email
		});
		if (result.error) {
			// Protection contre énumération de comptes : on ne différencie
			// PAS "email déjà utilisé" de "signup indisponible" dans le
			// message UI — sinon un attaquant peut sonder l'existence d'un
			// email en tentant un signup. Seule exception : les erreurs
			// clairement liées au mot de passe (longueur), qui sont
			// actionnables sans révéler d'info sur l'existence du compte.
			const rawMessage = result.error.message ?? "";
			const errorCode =
				(result.error as { code?: string } | undefined)?.code ?? "";
			const isPasswordIssue =
				PASSWORD_ERROR_RE.test(rawMessage) ||
				errorCode === "PASSWORD_TOO_SHORT";
			setError(
				isPasswordIssue
					? "Mot de passe trop court (8 caractères minimum)."
					: "Impossible de créer le compte. Si cet email est déjà utilisé, essaie de te connecter ou de réinitialiser ton mot de passe."
			);
			setIsSubmitting(false);
			return;
		}
		await queryClient.invalidateQueries({ queryKey: AUTH_SESSION_QUERY_KEY });
		void navigate({ to: "/" });
	};

	return (
		<div>
			<h2 style={titleStyle}>Créer un compte</h2>
			<p style={subtitleStyle}>
				Un compte, un canvas de schémas — commence en 30 secondes.
			</p>

			{error ? (
				<Alert color="red" variant="light" mb="md" title="Inscription refusée">
					{error}
				</Alert>
			) : null}

			<form style={formStyle} onSubmit={handleSubmit} noValidate>
				<TextInput
					label="Nom (optionnel)"
					value={name}
					onChange={(e) => setName(e.currentTarget.value)}
					autoComplete="name"
					disabled={isSubmitting}
				/>
				<TextInput
					label="Email"
					type="email"
					value={email}
					onChange={(e) => setEmail(e.currentTarget.value)}
					autoComplete="email"
					required
					disabled={isSubmitting}
				/>
				<PasswordInput
					label="Mot de passe"
					value={password}
					onChange={(e) => setPassword(e.currentTarget.value)}
					autoComplete="new-password"
					required
					disabled={isSubmitting}
					description="Au moins 8 caractères."
				/>
				<PasswordInput
					label="Confirmer le mot de passe"
					value={confirm}
					onChange={(e) => setConfirm(e.currentTarget.value)}
					autoComplete="new-password"
					required
					disabled={isSubmitting}
					error={passwordsMismatch ? "Les mots de passe diffèrent." : undefined}
				/>
				<Button
					type="submit"
					loading={isSubmitting}
					loadingLabel="Création…"
					disabled={
						email.trim() === "" ||
						password === "" ||
						confirm === "" ||
						passwordsMismatch
					}
				>
					Créer mon compte
				</Button>
			</form>

			<OAuthButtons callbackURL="/" />

			<div style={footerStyle}>
				Déjà un compte ?{" "}
				<Link to="/login" style={linkStyle}>
					Se connecter
				</Link>
			</div>
		</div>
	);
}
