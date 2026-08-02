import { createFileRoute } from "@tanstack/react-router";
import { isSafePath } from "../features/auth/isSafe";
import { LoginPage } from "../features/auth/LoginPage";

/**
 * Route /login (sous `_auth` — layout centered card).
 *
 * `validateSearch` : on typifie `redirect` comme un `string | undefined`.
 * C'est le `_authenticated` guard qui le pose (avec `location.href`) quand
 * un anonyme tape une URL protégée — on le relit ici pour renvoyer
 * l'utilisateur à sa page d'origine après connexion.
 */
interface LoginSearch {
	redirect?: string;
}

function validateSearch(raw: Record<string, unknown>): LoginSearch {
	if (isSafePath(raw.redirect)) {
		return { redirect: raw.redirect };
	}
	return {};
}

export const Route = createFileRoute("/_auth/login")({
	component: LoginPage,
	validateSearch
});

export { isSafePath };
