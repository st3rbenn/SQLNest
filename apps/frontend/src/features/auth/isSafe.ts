/**
 * Protection contre open redirect / open callback.
 *
 * On n'accepte QUE des chemins internes commençant par `/` et sans les
 * formes ambiguës `//host` ou `/\host` qui seraient interprétées comme
 * protocol-relative / windows-path par certains navigateurs et
 * permettraient un redirect off-origin.
 *
 * Utilisé par :
 * - `validateSearch` de `/login` (defense-in-depth au parsing du query
 *   param `?redirect=…` posé par le `_authenticated` guard),
 * - `OAuthButtons` (validation du `callbackURL` avant de le passer à
 *   `signIn.social(...)`),
 * - lu à nouveau côté page `LoginPage` avant tout `navigate`.
 */

/** Regex hoistée (bilan biome useTopLevelRegex — évite la recompile
 * à chaque appel). Matche %0A / %0a (LF) et %0D / %0d (CR) encodés,
 * qui permettraient une CRLF injection dans un header si le path est
 * réinjecté ailleurs qu'un `navigate()` TanStack Router (par ex.
 * `window.location.assign`, `fetch(url)`, `img src`). */
const CRLF_ENCODED_RE = /%0[ad]/i;

export function isSafePath(v: unknown): v is string {
	if (typeof v !== "string" || v.length === 0) return false;
	if (!v.startsWith("/")) return false;
	if (v.startsWith("//")) return false;
	if (v.startsWith("/\\")) return false;
	// CR/LF littéraux (rejette une URL brute avec un vrai \n).
	if (v.includes("\r") || v.includes("\n")) return false;
	// CR/LF encodés %0A/%0D — évite l'injection de headers si le path
	// finit dans une location.assign ou un fetch (defense-in-depth).
	if (CRLF_ENCODED_RE.test(v)) return false;
	return true;
}

/** Alias — même contrat, garde une signature `string` pour les callers
 * qui ont déjà validé le type en amont (pas d'unknown narrowing). */
export function isSafeCallback(v: string): boolean {
	return isSafePath(v);
}
