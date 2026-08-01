import fp from "fastify-plugin";

/**
 * Plugin session — hook `preHandler` global qui populate `request.user`.
 *
 * Dépend de `03-auth` (fastify.auth.api.getSession doit exister).
 *
 * ─── Contrat ───────────────────────────────────────────────────────────
 * Pour CHAQUE requête entrante (sauf `/api/auth/*`, cf. plus bas) :
 *   1. Convertit les headers Node en `Headers` Web API.
 *   2. Appelle `fastify.auth.api.getSession({ headers })` — Better Auth
 *      lit le cookie de session (préfixé `sqlnest.session`), le valide, et
 *      renvoie `{ session, user } | null`.
 *   3. Assigne `request.user` (déjà décoré à `null` en défaut) à un objet
 *      minimal `{ id, email, emailVerified, name }` — on ne partage PAS
 *      la session complète pour éviter de fuiter `token`/`ipAddress` dans
 *      les handlers.
 *
 * ─── Ne JAMAIS rejeter ici ─────────────────────────────────────────────
 * Le hook fire sur toutes les routes, y compris les routes publiques
 * (`/health`, `/api/schema`, etc.). Un cookie absent ou expiré doit se
 * traduire par `request.user = null`, PAS par un 401. Le guard `requireUser`
 * (voir `domains/auth/require.ts`) fait le 401 sur les routes protégées.
 *
 * ─── Skip pour `/api/auth/*` ───────────────────────────────────────────
 * Better Auth gère sa propre session côté handler catch-all — refaire un
 * `getSession` ici serait inutile (double lookup DB) et pourrait
 * interférer avec des flows en cours (ex: OAuth callback qui pose le
 * cookie via `Set-Cookie`, on lit un ancien).
 *
 * ─── decorateRequest défensif ──────────────────────────────────────────
 * Fastify exige que `decorateRequest` soit appelé AVANT le premier
 * `preHandler` qui assigne le champ, sinon l'assignation crée une
 * shape-transition monomorphique → perf V8 dégradée. On décore avec
 * `null` (primitive → partageable entre requêtes).
 */
export default fp(
	async (fastify) => {
		fastify.decorateRequest("user", null);

		fastify.addHook("preHandler", async (request) => {
			if (request.url.startsWith("/api/auth/")) {
				return;
			}

			// Conversion headers Node → Web Headers pour Better Auth.
			const headers = new Headers();
			for (const [key, value] of Object.entries(request.headers)) {
				if (typeof value === "string") {
					headers.append(key, value);
				} else if (Array.isArray(value)) {
					for (const v of value) {
						headers.append(key, v);
					}
				}
			}

			try {
				const session = await fastify.auth.api.getSession({ headers });
				if (session?.user) {
					request.user = {
						id: session.user.id,
						email: session.user.email,
						emailVerified: session.user.emailVerified,
						name: session.user.name ?? null
					};
				} else {
					request.user = null;
				}
			} catch (err) {
				// Un cookie corrompu ou une session révoquée ne doit pas casser la
				// requête entière — on log et on tombe en anonyme.
				request.log.warn({ err }, "session lookup failed");
				request.user = null;
			}
		});
	},
	{
		name: "04-session",
		dependencies: ["03-auth"]
	}
);
