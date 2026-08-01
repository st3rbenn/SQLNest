import { createFileRoute } from "@tanstack/react-router";
import { VerifyEmailPage } from "../features/auth/VerifyEmailPage";

/**
 * Route /verify-email?token=... — token normalement fourni par le lien reçu
 * par email (Better Auth). Sans token, on n'échoue pas côté router (un
 * `throw` ici casse tout l'app en errorBoundary sans CTA utile) : on
 * propage `null` et la page rend un composant "Lien invalide" avec CTA.
 */
interface VerifyEmailSearch {
	token: string | null;
}

function validateSearch(raw: Record<string, unknown>): VerifyEmailSearch {
	if (typeof raw.token === "string" && raw.token.length > 0) {
		return { token: raw.token };
	}
	return { token: null };
}

export const Route = createFileRoute("/_auth/verify-email")({
	component: VerifyEmailPage,
	validateSearch
});
