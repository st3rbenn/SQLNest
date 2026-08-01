import { createAuthClient } from "better-auth/react";

/**
 * Client Better Auth côté frontend.
 *
 * `baseURL` doit pointer sur le mount `/api/auth` du backend (catch-all
 * Better Auth). Le chemin réel est composé à partir de `window.CONTEXT.apiBaseUrl`
 * (chargé depuis `/public/config/context.js`) pour rester dev/staging/prod-agnostique.
 *
 * Le SDK gère `credentials: 'include'` par défaut sur les requêtes — le cookie
 * de session (préfixe `sqlnest.`, HTTP-only, SameSite=Lax, cf. Bloc 2) est
 * envoyé automatiquement, à condition que CORS backend expose
 * `credentials: true` (déjà en place).
 */
export const authClient = createAuthClient({
	baseURL: `${window.CONTEXT.apiBaseUrl}/api/auth`
});

/**
 * `useSession` de better-auth NON ré-exporté volontairement — il vit dans un
 * nanostore interne qui n'est PAS synchronisé avec le cache React Query.
 * Toujours utiliser `useCurrentUser` (features/auth/sessionQuery.ts) qui
 * garantit UNE seule source de vérité (le cache RQ, invalidé explicitement
 * par les mutations signIn/signOut et par le guard `_authenticated`).
 */
export const {
	signIn,
	signUp,
	signOut,
	forgetPassword,
	resetPassword,
	getSession
} = authClient;
