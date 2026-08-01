import { Alert, PasswordInput } from "@mantine/core";
import { Button, showNotification } from "@sqlnest/design-system";
import { Link, useNavigate } from "@tanstack/react-router";
import { type CSSProperties, type FormEvent, useState } from "react";
import { Route as ResetRoute } from "../../routes/_auth.reset-password";
import { resetPassword } from "./authClient";

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

const centerStyle: CSSProperties = {
	display: "flex",
	flexDirection: "column",
	alignItems: "center",
	gap: 14,
	padding: "16px 0"
};

/**
 * Sous-composant "Lien invalide" — token absent dans le search.
 * On oriente l'utilisateur vers `/forgot-password` pour en générer un nouveau.
 */
function TokenMissing() {
	return (
		<div>
			<h2 style={titleStyle}>Lien invalide</h2>
			<p style={subtitleStyle}>
				Ce lien de réinitialisation ne contient pas de jeton. Il a peut-être
				expiré — demande un nouveau lien.
			</p>
			<div style={centerStyle}>
				<Link to="/forgot-password">
					<Button>Recevoir un nouveau lien</Button>
				</Link>
			</div>
			<div style={footerStyle}>
				<Link to="/login" style={linkStyle}>
					Retour à la connexion
				</Link>
			</div>
		</div>
	);
}

/**
 * Page /reset-password?token=...
 *
 * Contrat :
 * - `search.token` peut être `null` — dans ce cas on rend `<TokenMissing />`.
 * - Form : nouveau mot de passe + confirmation.
 * - Succès : notification globale + `navigate({ to: '/login' })` — le nouveau
 *   mot de passe est actif, l'utilisateur doit se re-log (Better Auth ne
 *   crée pas de session côté reset password).
 * - Erreur : Alert (token expiré / invalide, mot de passe trop faible, etc.).
 */
export function ResetPasswordPage() {
	const { token } = ResetRoute.useSearch();

	if (token === null) {
		return <TokenMissing />;
	}

	return <ResetPasswordInner token={token} />;
}

function ResetPasswordInner({ token }: { token: string }) {
	const navigate = useNavigate();
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
		const result = await resetPassword({
			newPassword: password,
			token
		});
		setIsSubmitting(false);
		if (result.error) {
			setError(
				result.error.message ??
					"Impossible de réinitialiser. Le lien a peut-être expiré."
			);
			return;
		}
		showNotification({
			id: "password-reset-success",
			title: "Mot de passe changé",
			message: "Connecte-toi avec ton nouveau mot de passe.",
			color: "green",
			autoClose: 5000
		});
		void navigate({ to: "/login" });
	};

	return (
		<div>
			<h2 style={titleStyle}>Nouveau mot de passe</h2>
			<p style={subtitleStyle}>Choisis un mot de passe pour ton compte.</p>

			{error ? (
				<Alert color="red" variant="light" mb="md">
					{error}
				</Alert>
			) : null}

			<form style={formStyle} onSubmit={handleSubmit} noValidate>
				<PasswordInput
					label="Nouveau mot de passe"
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
					loadingLabel="Enregistrement…"
					disabled={password === "" || confirm === "" || passwordsMismatch}
				>
					Changer le mot de passe
				</Button>
			</form>

			<div style={footerStyle}>
				<Link to="/login" style={linkStyle}>
					Retour à la connexion
				</Link>
			</div>
		</div>
	);
}
