import { Alert, TextInput } from "@mantine/core";
import { Button } from "@sqlnest/design-system";
import { Link } from "@tanstack/react-router";
import { type CSSProperties, type FormEvent, useState } from "react";
import { requestPasswordReset } from "./authClient";

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
 * Page /forgot-password.
 *
 * Contrat enumeration-safe : on affiche **toujours** le même message succès
 * (« Si cet email existe, un lien a été envoyé »), qu'un compte existe ou
 * pas. Better Auth fait déjà le boulot côté backend (`requestPasswordReset`
 * répond 200 dans les deux cas), on ne relaie pas non plus l'erreur métier
 * si elle contient un signal — on ne s'en préoccupe que pour les erreurs
 * réseau/500 (`result.error && status >= 500`).
 *
 * `redirectTo` : URL absolue où l'utilisateur atterrit depuis l'email
 * (`/reset-password?token=...` — Better Auth ajoute le `token` en query).
 */
export function ForgotPasswordPage() {
	const [email, setEmail] = useState("");
	const [isSubmitting, setIsSubmitting] = useState(false);
	const [submitted, setSubmitted] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
		e.preventDefault();
		setError(null);
		setIsSubmitting(true);
		const redirectTo = `${window.location.origin}/reset-password`;
		const result = await requestPasswordReset({ email, redirectTo });
		setIsSubmitting(false);
		// Cas 5xx uniquement — on affiche l'erreur pour débug. Un 4xx sur
		// email inconnu ne devrait pas remonter ici (Better Auth renvoie
		// 200 par design pour éviter l'énumération).
		if (result.error && (result.error.status ?? 0) >= 500) {
			setError(result.error.message ?? "Erreur serveur. Réessaie.");
			return;
		}
		setSubmitted(true);
	};

	return (
		<div>
			<h2 style={titleStyle}>Mot de passe oublié</h2>
			<p style={subtitleStyle}>
				On envoie un lien de réinitialisation à ton adresse email.
			</p>

			{error ? (
				<Alert color="red" variant="light" mb="md">
					{error}
				</Alert>
			) : null}

			{submitted ? (
				<Alert color="green" variant="light">
					Si un compte existe pour <b>{email}</b>, tu recevras un lien de
					réinitialisation dans quelques instants.
				</Alert>
			) : (
				<form style={formStyle} onSubmit={handleSubmit} noValidate>
					<TextInput
						label="Email"
						type="email"
						value={email}
						onChange={(e) => setEmail(e.currentTarget.value)}
						autoComplete="off"
						required
						disabled={isSubmitting}
					/>
					<Button
						type="submit"
						loading={isSubmitting}
						loadingLabel="Envoi…"
						disabled={email.trim() === ""}
					>
						Envoyer le lien
					</Button>
				</form>
			)}

			<div style={footerStyle}>
				<Link to="/login" style={linkStyle}>
					Retour à la connexion
				</Link>
			</div>
		</div>
	);
}
