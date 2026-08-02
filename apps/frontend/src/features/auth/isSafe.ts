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

export function isSafePath(v: unknown): v is string {
	if (typeof v !== "string" || v.length === 0) return false;
	if (!v.startsWith("/")) return false;
	if (v.startsWith("//")) return false;
	if (v.startsWith("/\\")) return false;
	return true;
}

/** Alias — même contrat, garde une signature `string` pour les callers
 * qui ont déjà validé le type en amont (pas d'unknown narrowing). */
export function isSafeCallback(v: string): boolean {
	return isSafePath(v);
}
