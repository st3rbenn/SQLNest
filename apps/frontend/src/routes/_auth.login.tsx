import { createFileRoute } from "@tanstack/react-router";
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

/**
 * Protection contre open redirect : on n'accepte QUE des chemins internes
 * commençant par `/` et sans les formes ambiguës `//host` ou `/\host` qui
 * seraient interprétées comme protocol-relative / windows-path par certains
 * navigateurs et permettraient un redirect off-origin.
 */
function isSafePath(v: unknown): v is string {
	if (typeof v !== "string" || v.length === 0) return false;
	if (!v.startsWith("/")) return false;
	if (v.startsWith("//")) return false;
	if (v.startsWith("/\\")) return false;
	return true;
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
