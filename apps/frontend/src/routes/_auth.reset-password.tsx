import { createFileRoute } from "@tanstack/react-router";
import { ResetPasswordPage } from "../features/auth/ResetPasswordPage";

/**
 * Route /reset-password?token=... — token normalement fourni par l'email
 * Better Auth. Sans token on n'échoue pas côté router (un `throw` ici
 * casse l'app en errorBoundary sans CTA utile) : on propage `null` et
 * la page rend un composant "Lien invalide" avec CTA `/forgot-password`.
 */
interface ResetPasswordSearch {
	token: string | null;
}

function validateSearch(raw: Record<string, unknown>): ResetPasswordSearch {
	if (typeof raw.token === "string" && raw.token.length > 0) {
		return { token: raw.token };
	}
	return { token: null };
}

export const Route = createFileRoute("/_auth/reset-password")({
	component: ResetPasswordPage,
	validateSearch
});
