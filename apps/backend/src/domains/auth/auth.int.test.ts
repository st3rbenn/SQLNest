/**
 * Tests d'intégration Better Auth end-to-end.
 *
 * ─── Localisation du fichier ──────────────────────────────────────────
 * Le catch-all Better Auth vit dans le plugin `03-auth.plugin.ts` (pas
 * dans une route file colocalisable). On place ces tests dans le
 * domaine `auth/` — cohérent avec le guard `require.ts` déjà présent
 * ici — plutôt que dans `src/plugins/` qui est exclu du coverage et
 * conceptuellement dédié au wiring, pas à la validation métier.
 *
 * ─── Suffixe `.int.test.ts` ───────────────────────────────────────────
 * Signale que ces tests requièrent Postgres up (container
 * `sqlnest-postgres-app` port 5434). `describe.skipIf(!DATABASE_URL)`
 * saute proprement quand la base est absente (CI sans docker par
 * exemple) — même pattern que `@sqlnest/engine`.
 *
 * ─── Ordre et isolation ───────────────────────────────────────────────
 * `beforeEach(truncateAuthTables)` : chaque test part d'une base auth
 * vide → indépendance totale. Nécessaire car les tests créent des
 * users avec les mêmes emails (pas de random suffix) — préférence sur
 * l'isolation à la performance (14 tests × TRUNCATE reste ~ms).
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
	vi
} from "vitest";
import { createTestApp, truncateAuthTables } from "../../utils/testapp";

// ─── Chargement du .env RACINE ───────────────────────────────────────
// Vitest ne charge PAS `.env` automatiquement. On reproduit ici la
// stratégie de `src/index.ts` : loadEnv depuis la racine monorepo,
// AVANT de créer l'app (les plugins lisent process.env à register).
// __dirname = .../apps/backend/src/domains/auth → 5 niveaux au-dessus
// pour atteindre la racine monorepo (auth → domains → src → backend →
// apps → root).
const rootEnv = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"..",
	"..",
	"..",
	".env"
);
loadEnv({ path: rootEnv, quiet: true });

// AUTH_SECRET peut être un placeholder dans le .env dev. On force une
// valeur valide pour les tests (>=32 chars, sans mot interdit par la
// regex de env.schema — même si createTestApp ne passe pas par env.schema,
// on garde la même contrainte pour rester cohérent).
process.env.AUTH_SECRET =
	process.env.AUTH_SECRET &&
	!/changeme|replace|placeholder/i.test(process.env.AUTH_SECRET)
		? process.env.AUTH_SECRET
		: "test-secret-super-long-value-32-chars-min-XX";

// Les tests n'utilisent aucun provider OAuth — on s'assure que Google/
// GitHub sont désactivés (`""` = provider non enregistré côté plugin
// auth). Utile si un `.env` local a défini par curiosité un clientId.
process.env.GOOGLE_CLIENT_ID ??= "";
process.env.GITHUB_CLIENT_ID ??= "";

// `BASE_URL` par défaut pour Better Auth. IMPORTANT : Vitest (via Vite)
// pré-remplit `process.env.BASE_URL = "/"` (base publique frontend). Le
// plugin `03-auth` ignore les valeurs non-http, mais on force ici la valeur
// explicite pour rester lisible côté test.
process.env.BASE_URL = "http://localhost:4000";

// TRUSTED_ORIGINS : Better Auth vérifie l'`origin` header en cross-origin.
// Vide en test (app.inject ne pose pas d'origin) → toléré.
process.env.TRUSTED_ORIGINS ??= "http://localhost:3000";

const DATABASE_URL = process.env.DATABASE_URL;

/**
 * Helper — extrait la header `set-cookie` renvoyée par une réponse
 * app.inject, sous forme d'array normalisé.
 *
 * app.inject peut renvoyer `set-cookie` comme string OU string[]. On
 * normalise pour simplifier les assertions.
 */
function getSetCookies(
	headers: Record<string, string | string[] | number | undefined>
): string[] {
	const raw = headers["set-cookie"];
	if (raw == null) return [];
	return Array.isArray(raw) ? raw.map(String) : [String(raw)];
}

/**
 * Helper — retourne le cookie `sqlnest.session_token=...` prêt à être
 * ré-injecté dans une requête suivante via `headers.cookie`.
 *
 * Le préfixe `sqlnest` est posé par le plugin auth via
 * `advanced.cookiePrefix`. Better Auth pose ~2 cookies (session_token +
 * signature ou callback state) — on retourne la concaténation `k=v`
 * séparée par `; ` (format cookie header standard).
 */
function extractSessionCookie(setCookies: string[]): string {
	// Ne garde que la partie `name=value` (drop `; Path=/; HttpOnly; ...`).
	const pairs = setCookies
		.map((c) => c.split(";")[0])
		.filter((p) => p.length > 0);
	return pairs.join("; ");
}

describe.skipIf(!DATABASE_URL)("Better Auth integration", () => {
	let app: FastifyInstance;

	beforeAll(async () => {
		app = createTestApp({ withAuth: true });
		await app.ready();
	});

	afterAll(async () => {
		await app.close();
		vi.clearAllMocks();
	});

	beforeEach(async () => {
		await truncateAuthTables(app);
	});

	// ─── Sign-up ──────────────────────────────────────────────────────

	test("POST /api/auth/sign-up/email crée un user + retourne un cookie de session", async () => {
		// On envoie un name explicite pour vérifier qu'il est persisté.
		// Le schéma DB force `name notNull default ''` : si Better Auth
		// oubliait le champ, un `''` serait persisté à la place — le test
		// prouve que la propagation frontend→BA→DB fonctionne.
		const response = await app.inject({
			method: "POST",
			url: "/api/auth/sign-up/email",
			headers: { "content-type": "application/json" },
			payload: {
				email: "alice@example.com",
				password: "correct-horse-battery-staple",
				name: "Alice"
			}
		});

		expect(response.statusCode).toBe(200);

		const body = response.json() as {
			user?: { id: string; email: string; name?: string };
		};
		expect(body.user).toBeDefined();
		expect(body.user?.email).toBe("alice@example.com");
		expect(body.user?.name).toBe("Alice");

		// Un cookie de session doit avoir été posé.
		const setCookies = getSetCookies(response.headers);
		expect(setCookies.length).toBeGreaterThan(0);
		// Préfixe personnalisé configuré dans 03-auth.plugin.ts.
		expect(setCookies.some((c) => c.startsWith("sqlnest"))).toBe(true);

		// Sanity check DB — le user existe avec emailVerified=false (Policy
		// v1 : requireEmailVerification=false → login autorisé sans vérif).
		const users = await app.db.execute(
			sql`SELECT id, email, name, email_verified FROM "user"`
		);
		expect(users.length).toBe(1);
		const row = users[0] as {
			id: string;
			email: string;
			name: string;
			email_verified: boolean;
		};
		expect(row.email).toBe("alice@example.com");
		expect(row.name).toBe("Alice");
		expect(row.email_verified).toBe(false);
	});

	// ─── Sign-in ──────────────────────────────────────────────────────

	test("POST /api/auth/sign-in/email avec bons creds retourne 200 + cookie", async () => {
		// Setup : créer le user d'abord.
		await app.inject({
			method: "POST",
			url: "/api/auth/sign-up/email",
			headers: { "content-type": "application/json" },
			payload: {
				email: "bob@example.com",
				password: "hunter2-hunter2",
				name: "Bob"
			}
		});

		// Sign-in avec les mêmes creds.
		const response = await app.inject({
			method: "POST",
			url: "/api/auth/sign-in/email",
			headers: { "content-type": "application/json" },
			payload: {
				email: "bob@example.com",
				password: "hunter2-hunter2"
			}
		});

		expect(response.statusCode).toBe(200);
		const body = response.json() as { user?: { email: string } };
		expect(body.user?.email).toBe("bob@example.com");

		const setCookies = getSetCookies(response.headers);
		expect(setCookies.length).toBeGreaterThan(0);
	});

	test("POST /api/auth/sign-in/email avec mauvais password est rejeté", async () => {
		// Setup user.
		await app.inject({
			method: "POST",
			url: "/api/auth/sign-up/email",
			headers: { "content-type": "application/json" },
			payload: {
				email: "carol@example.com",
				password: "the-real-password",
				name: "Carol"
			}
		});

		const response = await app.inject({
			method: "POST",
			url: "/api/auth/sign-in/email",
			headers: { "content-type": "application/json" },
			payload: {
				email: "carol@example.com",
				password: "wrong-password"
			}
		});

		// Better Auth renvoie 401 sur bad-creds (peut aussi être 400 selon
		// version). Ce qui compte : PAS 200, et pas de cookie de session.
		expect(response.statusCode).not.toBe(200);
		expect(response.statusCode).toBeGreaterThanOrEqual(400);

		const setCookies = getSetCookies(response.headers);
		// Pas de cookie de session valide posé (Better Auth peut poser un
		// petit cookie utilitaire comme `dont_remember`, mais aucun
		// `session_token`).
		expect(setCookies.every((c) => !c.includes("session_token"))).toBe(true);
	});

	// ─── Sign-out ─────────────────────────────────────────────────────

	test("POST /api/auth/sign-out invalide la session côté DB", async () => {
		// Sign-up → récupère cookie.
		const signUp = await app.inject({
			method: "POST",
			url: "/api/auth/sign-up/email",
			headers: { "content-type": "application/json" },
			payload: {
				email: "dave@example.com",
				password: "very-long-password-123",
				name: "Dave"
			}
		});
		const cookie = extractSessionCookie(getSetCookies(signUp.headers));
		expect(cookie.length).toBeGreaterThan(0);

		// Vérifie qu'il y a 1 session en DB.
		const beforeSignOut = await app.db.execute(
			sql`SELECT COUNT(*)::int AS n FROM "session"`
		);
		expect((beforeSignOut[0] as { n: number }).n).toBe(1);

		// Sign-out avec le cookie. Better Auth 1.6.25 attend un body JSON
		// même vide (`{}`) — un POST sans body avec content-type json est
		// rejeté par le validator interne (`better-call`) en 400.
		const signOut = await app.inject({
			method: "POST",
			url: "/api/auth/sign-out",
			headers: { cookie, "content-type": "application/json" },
			payload: {}
		});

		// Better Auth renvoie 200 sur sign-out (idempotent-ish).
		expect(signOut.statusCode).toBe(200);

		// La session doit avoir été supprimée en DB.
		const afterSignOut = await app.db.execute(
			sql`SELECT COUNT(*)::int AS n FROM "session"`
		);
		expect((afterSignOut[0] as { n: number }).n).toBe(0);
	});

	// ─── get-session ──────────────────────────────────────────────────

	test("GET /api/auth/get-session avec cookie valide retourne le user", async () => {
		const signUp = await app.inject({
			method: "POST",
			url: "/api/auth/sign-up/email",
			headers: { "content-type": "application/json" },
			payload: {
				email: "erin@example.com",
				password: "yetanother-password-456",
				name: "Erin"
			}
		});
		const cookie = extractSessionCookie(getSetCookies(signUp.headers));

		const response = await app.inject({
			method: "GET",
			url: "/api/auth/get-session",
			headers: { cookie }
		});

		expect(response.statusCode).toBe(200);
		const body = response.json() as {
			user?: { email: string };
			session?: { id: string };
		} | null;
		expect(body).not.toBeNull();
		expect(body?.user?.email).toBe("erin@example.com");
		expect(body?.session?.id).toBeDefined();
	});

	test("GET /api/auth/get-session sans cookie retourne null", async () => {
		const response = await app.inject({
			method: "GET",
			url: "/api/auth/get-session"
		});

		// Better Auth renvoie 200 avec body `null` (pas 401) — comportement
		// idiomatique pour un endpoint "session courante or null" utilisé
		// depuis le frontend en boot.
		expect(response.statusCode).toBe(200);
		const body = response.json();
		expect(body).toBeNull();
	});

	// ─── Index fonctionnel user_email_lower_unique ────────────────────

	test("un signup avec un email en case différent est rejeté (index user_email_lower_unique)", async () => {
		// 1er signup : alice@example.com (minuscule).
		const first = await app.inject({
			method: "POST",
			url: "/api/auth/sign-up/email",
			headers: { "content-type": "application/json" },
			payload: {
				email: "frank@example.com",
				password: "solid-password-789",
				name: "Frank"
			}
		});
		expect(first.statusCode).toBe(200);

		// 2e signup : FRANK@example.com (majuscule). L'index Postgres
		// `CREATE UNIQUE INDEX user_email_lower_unique ON "user" (lower(email))`
		// doit rejeter cette insertion — la protection anti-énumération
		// case-insensitive est le point testé ici.
		const second = await app.inject({
			method: "POST",
			url: "/api/auth/sign-up/email",
			headers: { "content-type": "application/json" },
			payload: {
				email: "FRANK@example.com",
				password: "another-password-789",
				name: "Frank2"
			}
		});

		// PAS 200 : soit Better Auth pré-check trouve le user existant
		// (case-insensitive via son propre normalizeEmail — dépend de la
		// version), soit Postgres throw et le catch-all renvoie 500. Dans
		// tous les cas, l'API doit refuser.
		expect(second.statusCode).not.toBe(200);

		// La DB ne doit contenir qu'UNE seule row `frank@example.com`
		// (dans n'importe quelle case) — c'est la garantie forte que
		// l'index a bien fait son job.
		const rows = await app.db.execute(
			sql`SELECT email FROM "user" WHERE lower(email) = 'frank@example.com'`
		);
		expect(rows.length).toBe(1);
	});

	// ─── Bonus : session hook `request.user` ──────────────────────────

	test("le hook 04-session populate request.user quand un cookie valide est présent", async () => {
		// Route de sonde dédiée — enregistrée UNIQUEMENT si on peut le
		// faire dynamiquement. Fastify n'autorise pas l'ajout de routes
		// après `.ready()` par défaut → on skip ce test si l'app est déjà
		// prête. Solution : créer une seconde app avec un endpoint de
		// sonde intégré. Ici on préfère la lisibilité et on utilise un
		// setup dédié.
		const probeApp = createTestApp({ withAuth: true });
		probeApp.get("/whoami", async (request) => ({ user: request.user }));
		await probeApp.ready();

		try {
			await truncateAuthTables(probeApp);

			const signUp = await probeApp.inject({
				method: "POST",
				url: "/api/auth/sign-up/email",
				headers: { "content-type": "application/json" },
				payload: {
					email: "grace@example.com",
					password: "grace-password-000",
					name: "Grace"
				}
			});
			const cookie = extractSessionCookie(getSetCookies(signUp.headers));

			// Sans cookie → request.user null.
			const anon = await probeApp.inject({ method: "GET", url: "/whoami" });
			expect(anon.statusCode).toBe(200);
			expect(anon.json()).toEqual({ user: null });

			// Avec cookie → request.user populé.
			const authed = await probeApp.inject({
				method: "GET",
				url: "/whoami",
				headers: { cookie }
			});
			expect(authed.statusCode).toBe(200);
			const body = authed.json() as {
				user: { id: string; email: string; name: string } | null;
			};
			expect(body.user).not.toBeNull();
			expect(body.user?.email).toBe("grace@example.com");
			expect(body.user?.name).toBe("Grace");
		} finally {
			await probeApp.close();
		}
	});
});
