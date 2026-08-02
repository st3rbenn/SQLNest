import { schema as dbSchema } from "@sqlnest/db";
import { type Auth, type BetterAuthOptions, betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import fp from "fastify-plugin";
import { createHashedSessionStorage } from "./03-auth/hashedSessionStorage";

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
			// ─── Politique de session + Policy B (hashing) ────────────────
			// `storeSessionInDatabase: false` désactive l'écriture BA dans la
			// table `session` — tout passe par notre `secondaryStorage` custom
			// (voir `03-auth/hashedSessionStorage.ts`) qui hash SHA-256 le
			// token et chiffre AES-256-GCM le payload. Un dump DB ne fuit ni
			// tokens de session actifs (préimage-résistance) ni les user data
			// dans les payloads.
			//
			// Expirations conservatives :
			//   - `expiresIn: 7j` (défaut BA = 30j) — plus courte durée =
			//     moindre fenêtre d'exploitation d'un cookie volé côté client
			//     (XSS, ordi partagé).
			//   - `updateAge: 1j` — refresh limité 1×/24h (évite les writes
			//     KV inutiles).
			session: {
				storeSessionInDatabase: false,
				expiresIn: 60 * 60 * 24 * 7,
				updateAge: 60 * 60 * 24
			},
			secondaryStorage: createHashedSessionStorage(
				fastify.db,
				process.env.AUTH_SECRET as string
			),
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

		// ─── Handler partagé forward vers Better Auth ─────────────────────
		// Extrait comme fonction pour être réutilisé par le catch-all ET par
		// les routes explicites qui ont un rate-limit strict (voir plus bas).
		const forwardToBetterAuth = async (
			request: import("fastify").FastifyRequest,
			reply: import("fastify").FastifyReply
		) => {
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

			let response: Response;
			try {
				response = await auth.handler(webRequest);
			} catch (err) {
				request.log.error({ err, url: url.toString() }, "auth handler failed");
				return reply.status(500).send({
					error: "auth_handler_error",
					message: "Auth internal error"
				});
			}

			reply.status(response.status);

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
		};

		// ─── Routes POST sensibles au brute-force (rate-limit strict) ─────
		// Scope de la limite 10/min :
		//   - UNIQUEMENT sur les POST qui acceptent un mot de passe ou email
		//     (sign-in/email, sign-up/email, forget-password, reset-password).
		//   - Key = `ip + email` du body — un IP partagé (NAT bureau, mobile
		//     carrier) n'atteint pas la limite juste parce que plusieurs
		//     utilisateurs se connectent en même temps ; en revanche, un
		//     attaquant qui brute-force UN compte est capé même en rotant
		//     l'IP (dans la mesure où la victime a un seul email).
		//   - `hook: "preHandler"` obligatoire pour lire `request.body`
		//     (défaut `onRequest` = trop tôt, body pas encore parsé).
		const AUTH_STRICT_LIMIT = {
			max: 10,
			timeWindow: "1 minute",
			hook: "preHandler" as const,
			keyGenerator: (request: import("fastify").FastifyRequest) => {
				const body = request.body as { email?: unknown } | undefined;
				const email =
					body && typeof body.email === "string" ? body.email : "anon";
				return `auth-strict:${request.ip}:${email}`;
			}
		};

		const SENSITIVE_POSTS = [
			"/api/auth/sign-in/email",
			"/api/auth/sign-up/email",
			"/api/auth/request-password-reset",
			"/api/auth/reset-password"
		];
		for (const path of SENSITIVE_POSTS) {
			fastify.route({
				method: "POST",
				url: path,
				config: { rateLimit: AUTH_STRICT_LIMIT },
				handler: forwardToBetterAuth
			});
		}

		// ─── Catch-all Better Auth ────────────────────────────────────────
		// PAS de config.rateLimit ici : les routes plus spécifiques
		// ci-dessus captent les POST brute-forceables ; le reste (dont
		// GET /api/auth/get-session qui est appelé à chaque navigation avec
		// staleTime:0) tombe sur le rate-limit GLOBAL 100/min appliqué par
		// `01-rate-limit.plugin.ts`.
		// PAS de withTypeProvider : Zod serializer casserait la réponse
		// Better Auth (JSON déjà sérialisé + Set-Cookie).
		fastify.route({
			method: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD"],
			url: "/api/auth/*",
			handler: forwardToBetterAuth
		});
	},
	{
		name: "03-auth",
		dependencies: ["02-db"]
	}
);
