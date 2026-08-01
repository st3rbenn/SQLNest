import { Alert, Loader } from "@mantine/core";
import { Button } from "@sqlnest/design-system";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type CSSProperties, useEffect } from "react";
import { queryClient } from "../../api/queryClient";
import { Route as VerifyRoute } from "../../routes/_auth.verify-email";
import { authClient } from "./authClient";
import { AUTH_SESSION_QUERY_KEY } from "./sessionQuery";

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

const centerStyle: CSSProperties = {
	display: "flex",
	flexDirection: "column",
	alignItems: "center",
	gap: 14,
	padding: "16px 0"
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
 * Sous-composant "Lien invalide" — token absent dans le search.
 * On propose deux CTA actionnables plutôt qu'un errorBoundary muet.
 */
function TokenMissing() {
	return (
		<div>
			<h2 style={titleStyle}>Lien invalide</h2>
			<p style={subtitleStyle}>
				Ce lien de vérification ne contient pas de jeton. Utilise le lien reçu
				par email — ou demande-en un nouveau.
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
 * Page /verify-email?token=...
 *
 * Contrat :
 * - `search.token` peut être `null` — dans ce cas on rend `<TokenMissing />`.
 * - Sinon on appelle `authClient.verifyEmail({ query: { token } })` (le SDK
 *   Better Auth gère la réponse 302/JSON et normalise en `{ data, error }`).
 * - States :
 *   - loading : spinner + "Vérification en cours…"
 *   - success : "Email vérifié" + CTA vers `/`. On invalide `['auth','session']`
 *     car Better Auth peut poser une session au verify (autoSignIn).
 *   - error : "Lien invalide ou expiré" + lien retour connexion.
 * - React Query gère les états + la déduplication (StrictMode double-mount).
 */
export function VerifyEmailPage() {
	const { token } = VerifyRoute.useSearch();

	if (token === null) {
		return <TokenMissing />;
	}

	return <VerifyEmailInner token={token} />;
}

function VerifyEmailInner({ token }: { token: string }) {
	const { isLoading, isSuccess, isError } = useQuery({
		queryKey: ["auth", "verify-email", token],
		queryFn: async () => {
			const result = await authClient.verifyEmail({ query: { token } });
			if (result.error) {
				throw new Error(result.error.message ?? "Lien invalide ou expiré.");
			}
			return result.data;
		},
		// Un seul essai — un token de verify est one-shot par nature, retry
		// masquerait la vraie cause (expiration, réutilisation).
		retry: false,
		staleTime: Number.POSITIVE_INFINITY,
		refetchOnMount: false,
		refetchOnWindowFocus: false
	});

	// Better Auth peut poser une session au moment du verify — on invalide
	// notre cache session pour que le prochain navigate voie l'utilisateur
	// connecté (sinon flash /login → / en cas d'autoSignIn).
	useEffect(() => {
		if (isSuccess) {
			void queryClient.invalidateQueries({
				queryKey: AUTH_SESSION_QUERY_KEY
			});
		}
	}, [isSuccess]);

	return (
		<div>
			<h2 style={titleStyle}>Vérification de l'email</h2>
			<p style={subtitleStyle}>On confirme ton adresse email.</p>

			{isLoading ? (
				<div style={centerStyle}>
					<Loader size="sm" />
					<span
						style={{
							fontSize: 13,
							color: "var(--sqlnest-text-secondary)"
						}}
					>
						Vérification en cours…
					</span>
				</div>
			) : null}

			{isSuccess ? (
				<div style={centerStyle}>
					<Alert color="green" variant="light" style={{ width: "100%" }}>
						Email vérifié. Ton compte est prêt.
					</Alert>
					<Link to="/">
						<Button>Ouvrir le canvas</Button>
					</Link>
				</div>
			) : null}

			{isError ? (
				<div style={centerStyle}>
					<Alert color="red" variant="light" style={{ width: "100%" }}>
						Ce lien est invalide ou a expiré. Demande un nouveau lien depuis ta
						page de connexion.
					</Alert>
				</div>
			) : null}

			<div style={footerStyle}>
				<Link to="/login" style={linkStyle}>
					Retour à la connexion
				</Link>
			</div>
		</div>
	);
}
