import { schema as dbSchema } from "@sqlnest/db";
import { type Auth, type BetterAuthOptions, betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import fp from "fastify-plugin";

// Regex top-level — Vite/Vitest injecte `process.env.BASE_URL = "/"` par
// défaut, on veut ignorer toute valeur qui n'est pas une URL http(s).
const HTTP_URL_RE = /^https?:\/\//;

/**
 * Plugin Better Auth — instance + catch-all `/api/auth/*`.
 *
 * Dépend de `02-db` (fastify.db doit exister pour l'adapter Drizzle).
 *
 * ─── Providers ─────────────────────────────────────────────────────────
 *   - email/password : TOUJOURS actif — pas de blocage par vérif email v1
 *     (`requireEmailVerification: false`). Les actions sensibles seront
 *     gatées côté UI plus tard.
 *   - Google OAuth : activé SI `GOOGLE_CLIENT_ID` ET `GOOGLE_CLIENT_SECRET`
 *     sont non vides. Sinon le provider n'est pas déclaré (Better Auth ne
 *     tolère pas des credentials vides).
 *   - GitHub OAuth : idem, gate sur les deux env vars.
 *   - 2FA : DIFFÉRÉ v1.1 — plugin `twoFactor()` NON instancié.
 *
 * ─── Policies verrouillées (Bloc 2) ────────────────────────────────────
 *   - Policy A — verification tokens HASHÉS :
 *     `verification.storeIdentifier: "hashed"` — Better Auth hash SHA-256
 *     les tokens avant persistance. Un dump DB ne suffit plus à exploiter
 *     un token de reset password / email verification.
 *
 *   - Policy B — session.token HASHÉ :
 *     NON supporté nativement par Better Auth 1.6.x. Le token de session
 *     stocké dans `session.token` est l'identifiant opaque envoyé au
 *     client via cookie, matché par égalité côté DB (SELECT WHERE token
 *     = ?). Hashing casserait le lookup. Cf. `known_gaps` + TODO S1.
 *
 *   - Policy C — OAuth tokens NON PERSISTÉS :
 *     Better Auth 1.6.x n'offre pas d'option `disableAccessTokenPersistence`.
 *     À la place on combine :
 *       - `account.encryptOAuthTokens: true` — AES-256-GCM au repos ;
 *       - `databaseHooks.account.create.before` (+ `.update.before`) — on
 *         nullifie explicitement `accessToken`/`refreshToken`/`idToken`
 *         avant persist, puisqu'on n'appelle jamais Google/GitHub API après
 *         la vérif OAuth initiale (Bloc 1 verrou : c'est SNQL/nos propres
 *         API côté frontend, pas les APIs providers).
 *     Résultat concret : les colonnes `access_token`/`refresh_token`/
 *     `id_token` restent NULL en DB pour tous les comptes 'google' et
 *     'github'.
 *
 * ─── Catch-all `/api/auth/*` ───────────────────────────────────────────
 * On enregistre la route via `fastify.route()` SANS `withTypeProvider`
 * (Zod serializerCompiler stripperait le payload JSON de Better Auth).
 * Le handler convertit request/reply Fastify ↔ Web API Request/Response.
 *
 * Attention aux cookies : `Response.headers.getSetCookie()` retourne le
 * tableau des Set-Cookie individuels (Node 20+), qu'on ré-écrit via
 * `reply.raw.setHeader('set-cookie', arr)`. Passer par `reply.header()`
 * dans une boucle écraserait les cookies précédents (Set-Cookie n'est pas
 * un header additif via setHeader).
 */
export default fp(
	async (fastify) => {
		// ─── Providers OAuth (opt-in via env) ─────────────────────────────
		const socialProviders: NonNullable<BetterAuthOptions["socialProviders"]> =
			{};

		const googleId = process.env.GOOGLE_CLIENT_ID;
		const googleSecret = process.env.GOOGLE_CLIENT_SECRET;
		if (googleId && googleSecret) {
			socialProviders.google = {
				clientId: googleId,
				clientSecret: googleSecret
			};
		}

		const githubId = process.env.GITHUB_CLIENT_ID;
		const githubSecret = process.env.GITHUB_CLIENT_SECRET;
		if (githubId && githubSecret) {
			socialProviders.github = {
				clientId: githubId,
				clientSecret: githubSecret
			};
		}

		// ─── Trusted origins + cookie domain ──────────────────────────────
		// Fallback dev "http://localhost:3000" : les defaults du JSON schema
		// @fastify/env peuplent `fastify.config` mais PAS `process.env` — si
		// l'utilisateur n'a pas explicitement TRUSTED_ORIGINS dans .env, on
		// retombe sur un dev-safe. En prod, cette liste DOIT être overridée
		// via env sinon Better Auth rejette toute origin (403 sign-up).
		const trustedOriginsRaw =
			process.env.TRUSTED_ORIGINS && process.env.TRUSTED_ORIGINS.length > 0
				? process.env.TRUSTED_ORIGINS
				: "http://localhost:3000";
		const trustedOrigins = trustedOriginsRaw
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);

		const isProduction = process.env.NODE_ENV === "production";
		const cookieDomain = process.env.COOKIE_DOMAIN?.trim();
		// ⚠️ NE PAS utiliser `process.env.BASE_URL || fallback` : Vite/Vitest
		// injecte `process.env.BASE_URL = "/"` par défaut (base path frontend),
		// et cette valeur casse Better Auth (URL sans protocole). On garde le
		// fallback UNIQUEMENT si BASE_URL commence par `http` — sinon on
		// l'ignore.
		const envBaseURL = process.env.BASE_URL;
		const baseURL =
			envBaseURL && HTTP_URL_RE.test(envBaseURL)
				? envBaseURL
				: "http://localhost:4000";

		// ─── Construction de l'instance Better Auth ───────────────────────
		const auth = betterAuth({
			database: drizzleAdapter(fastify.db, {
				provider: "pg",
				schema: dbSchema
			}),
			// AUTH_SECRET validé par env.schema (minLength 32, rejet placeholders).
			// Cast obligatoire : env.schema garantit sa présence mais TS ne le sait pas.
			secret: process.env.AUTH_SECRET as string,
			baseURL,
			trustedOrigins,
			emailAndPassword: {
				enabled: true,
				requireEmailVerification: false,
				autoSignIn: true
			},
			socialProviders,
			// Policy A — hashing des tokens de vérification (SHA-256 avant persist).
			verification: {
				storeIdentifier: "hashed"
			},
			// Policy C — chiffrement AES-256-GCM des tokens OAuth au repos +
			// null-out via hooks (voir databaseHooks ci-dessous).
			account: {
				encryptOAuthTokens: true
			},
			// Policy C (suite) — annule les tokens OAuth avant insert/update en DB.
			databaseHooks: {
				account: {
					create: {
						before: async (account) => ({
							data: {
								...account,
								accessToken: null,
								refreshToken: null,
								idToken: null,
								accessTokenExpiresAt: null,
								refreshTokenExpiresAt: null,
								scope: null
							}
						})
					},
					update: {
						before: async (account) => ({
							data: {
								...account,
								accessToken: null,
								refreshToken: null,
								idToken: null,
								accessTokenExpiresAt: null,
								refreshTokenExpiresAt: null,
								scope: null
							}
						})
					}
				}
			},
			advanced: {
				// Préfixe distinctif des cookies pour éviter les collisions en dev
				// (plusieurs apps sur localhost) et faciliter le debug.
				cookiePrefix: "sqlnest",
				// En prod, force Secure sur tous les cookies (Chrome refuse Cross-site
				// cookies sans Secure). En dev on laisse Better Auth décider (false).
				useSecureCookies: isProduction,
				// COOKIE_DOMAIN=".sqlnest.io" en prod → partage entre sous-domaines
				// app.sqlnest.io + api.sqlnest.io. Vide en dev (localhost).
				...(cookieDomain
					? {
							crossSubDomainCookies: {
								enabled: true,
								domain: cookieDomain
							}
						}
					: {})
			}
		});

		// Cast obligatoire : `betterAuth<Options>` renvoie `Auth<InferredOptions>`
		// (Options inférées depuis notre littéral), qui n'est PAS assignable à
		// `Auth<BetterAuthOptions>` (variance invariante sur `$context.adapter:
		// DBAdapter<Options>`). On accepte la perte de précision typing sur
		// l'API endpoints — les handlers courants (`.handler(req)`,
		// `.api.getSession(...)`) restent typés correctement via l'interface
		// racine `Auth`.
		fastify.decorate("auth", auth as unknown as Auth);

		// ─── Catch-all Better Auth ────────────────────────────────────────
		// PAS de withTypeProvider ici : Zod serializer casserait la réponse
		// de Better Auth (qui renvoie du JSON déjà sérialisé + Set-Cookie).
		fastify.route({
			method: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD"],
			url: "/api/auth/*",
			handler: async (request, reply) => {
				// Reconstruit une URL absolue — Better Auth en a besoin pour ses
				// vérifs d'origin/redirect + OAuth callbacks. Honore les headers
				// de reverse proxy (x-forwarded-proto/host) sinon le scheme reste
				// figé à http:// et les redirects OAuth cassent derrière un
				// TLS-terminator (nginx/Caddy/ALB en prod).
				const fwdProtoHdr = request.headers["x-forwarded-proto"];
				const fwdHostHdr = request.headers["x-forwarded-host"];
				const forwardedProto = Array.isArray(fwdProtoHdr)
					? fwdProtoHdr[0]
					: fwdProtoHdr;
				const forwardedHost = Array.isArray(fwdHostHdr)
					? fwdHostHdr[0]
					: fwdHostHdr;
				const proto = forwardedProto ?? request.protocol ?? "http";
				const host = forwardedHost ?? request.headers.host ?? "localhost";
				const url = new URL(request.url, `${proto}://${host}`);

				// Node headers (Record<string, string | string[]>) → Web Headers.
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

				// Fastify parse le body JSON par défaut — on le re-sérialise pour
				// le passer à Better Auth qui attend un Request Web API standard.
				const hasBody = !["GET", "HEAD"].includes(request.method);
				const body =
					hasBody && request.body !== undefined
						? JSON.stringify(request.body)
						: undefined;

				const webRequest = new Request(url.toString(), {
					method: request.method,
					headers,
					body
				});

				// try/catch défensif : une exception BA non catchée = 500 sans
				// log structuré. On log via request.log (Pino contextuel) puis
				// on renvoie un 500 JSON minimal sans leak d'internals.
				let response: Response;
				try {
					response = await auth.handler(webRequest);
				} catch (err) {
					request.log.error(
						{ err, url: url.toString() },
						"auth handler failed"
					);
					return reply.status(500).send({
						error: "auth_handler_error",
						message: "Auth internal error"
					});
				}

				reply.status(response.status);

				// Set-Cookie : on isole ces headers pour préserver les valeurs
				// multiples (Response.headers.getSetCookie() est le seul moyen
				// robuste — .forEach() combine avec virgules et casse la date des
				// cookies).
				const setCookies =
					typeof response.headers.getSetCookie === "function"
						? response.headers.getSetCookie()
						: [];

				response.headers.forEach((value, key) => {
					if (key.toLowerCase() === "set-cookie") return;
					reply.header(key, value);
				});

				if (setCookies.length > 0) {
					reply.raw.setHeader("set-cookie", setCookies);
				}

				const text = await response.text();
				return reply.send(text.length > 0 ? text : null);
			}
		});
	},
	{
		name: "03-auth",
		dependencies: ["02-db"]
	}
);
