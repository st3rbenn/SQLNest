/**
 * Tests d'intégration `/api/canvas-state` end-to-end.
 *
 * ─── Localisation ─────────────────────────────────────────────────────
 * Colocalisé avec la logique métier dans `domains/canvas-state/` (comme
 * `domains/auth/auth.int.test.ts`) — les tests intégration sont plus
 * proches du domaine testé que de la route (qui est juste le wiring
 * HTTP).
 *
 * ─── Suffixe `.int.test.ts` ────────────────────────────────────────────
 * Signale que ces tests requièrent Postgres up (container
 * `sqlnest-postgres-app` port 5434). `describe.skipIf(!DATABASE_URL)`
 * saute proprement quand la base est absente (CI sans docker par
 * exemple).
 *
 * ─── Isolation ─────────────────────────────────────────────────────────
 * `beforeEach` TRUNCATE (user, session, account, verification, canvas_state)
 * — un test = un état DB propre. `canvas_state.user_id` est CASCADE via
 * l'FK vers `user.id`, donc le TRUNCATE via `truncateAuthTables` vide
 * aussi implicitement `canvas_state`. On garde `canvas_state` dans le
 * TRUNCATE explicite pour la lisibilité (montre l'intent).
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
import canvasStateRoute from "../../routes/api/canvas-state/root";
import { createTestApp, truncateCanvasAndAuth } from "../../utils/testapp";

// ─── Chargement du .env RACINE ───────────────────────────────────────
// Vitest ne charge PAS `.env` automatiquement. Réplique la stratégie
// d'`auth.int.test.ts` : loadEnv depuis la racine monorepo AVANT de créer
// l'app (les plugins lisent process.env à register).
// __dirname = .../apps/backend/src/domains/canvas-state → 5 niveaux au-dessus
// pour atteindre la racine monorepo (canvas-state → domains → src → backend
// → apps → root).
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
// regex de env.schema).
process.env.AUTH_SECRET =
	process.env.AUTH_SECRET &&
	!/changeme|replace|placeholder/i.test(process.env.AUTH_SECRET)
		? process.env.AUTH_SECRET
		: "test-secret-super-long-value-32-chars-min-XX";

// Providers OAuth désactivés en test.
process.env.GOOGLE_CLIENT_ID ??= "";
process.env.GITHUB_CLIENT_ID ??= "";

process.env.BASE_URL = "http://localhost:4000";
process.env.TRUSTED_ORIGINS ??= "http://localhost:3000";

const DATABASE_URL = process.env.DATABASE_URL;

/** app.inject peut renvoyer set-cookie en string OU string[] : on normalise. */
function getSetCookies(
	headers: Record<string, string | string[] | number | undefined>
): string[] {
	const raw = headers["set-cookie"];
	if (raw == null) return [];
	return Array.isArray(raw) ? raw.map(String) : [String(raw)];
}

/** Réduit chaque cookie à sa paire `name=value` (drop `; Path=/; HttpOnly...`). */
function extractSessionCookie(setCookies: string[]): string {
	const pairs = setCookies
		.map((c) => c.split(";")[0])
		.filter((p) => p.length > 0);
	return pairs.join("; ");
}

/**
 * Helper — crée un user via Better Auth et retourne le cookie de session
 * prêt à être injecté dans les requêtes suivantes.
 *
 * Retourne aussi l'`id` du user (via GET /api/auth/get-session juste
 * après) — utile pour les assertions cross-user (isolation).
 */
async function createTestUser(
	app: FastifyInstance,
	email: string,
	password: string
): Promise<{ cookie: string; userId: string }> {
	const signUp = await app.inject({
		method: "POST",
		url: "/api/auth/sign-up/email",
		headers: { "content-type": "application/json" },
		payload: { email, password, name: email.split("@")[0] }
	});
	if (signUp.statusCode !== 200) {
		throw new Error(
			`sign-up failed for ${email}: ${signUp.statusCode} ${signUp.payload}`
		);
	}

	const cookie = extractSessionCookie(getSetCookies(signUp.headers));
	if (!cookie) {
		throw new Error(`no session cookie returned for ${email}`);
	}

	const body = signUp.json() as { user?: { id?: string } };
	const userId = body.user?.id;
	if (!userId) {
		throw new Error(`no user.id returned for ${email}`);
	}

	return { cookie, userId };
}

describe.skipIf(!DATABASE_URL)("/api/canvas-state integration", () => {
	let app: FastifyInstance;

	beforeAll(async () => {
		app = createTestApp({ withAuth: true });
		// Register manuel du plugin route — `createTestApp` ne fait pas d'
		// autoload. On utilise le prefix `/api/canvas-state` (identique à
		// l'autoload en runtime : `src/routes/api/canvas-state/` → `/api/canvas-state`).
		await app.register(canvasStateRoute, { prefix: "/api/canvas-state" });
		await app.ready();
	});

	afterAll(async () => {
		await app.close();
		vi.clearAllMocks();
	});

	beforeEach(async () => {
		// TRUNCATE inclut explicitement canvas_state — le CASCADE via
		// user.id le viderait aussi, mais l'ordre explicite documente
		// l'intent. Le helper enforce la garde "DATABASE_URL doit contenir
		// 'test'" pour éviter de wiper la DB dev.
		await truncateCanvasAndAuth(app);
	});

	// ─── 1. Guard : requireUser ───────────────────────────────────────
	test("GET sans cookie → 401", async () => {
		const response = await app.inject({
			method: "GET",
			url: "/api/canvas-state?signature=postgres:users"
		});
		expect(response.statusCode).toBe(401);
		const body = response.json() as { message?: string };
		expect(body.message).toBe("Non authentifié");
	});

	// ─── 2. GET avec cookie mais signature jamais synchronisée → 404 ──
	test("GET avec cookie mais signature jamais synchronisée → 404", async () => {
		const { cookie } = await createTestUser(
			app,
			"alice@example.com",
			"correct-horse-battery-staple"
		);

		const response = await app.inject({
			method: "GET",
			url: "/api/canvas-state?signature=postgres:users",
			headers: { cookie }
		});
		expect(response.statusCode).toBe(404);
		const body = response.json() as { message?: string };
		expect(body.message).toBe("Canvas introuvable");
	});

	// ─── 3. PUT première fois → 200 + row en DB ───────────────────────
	test("PUT première fois → 200 { updatedAt } + row en DB", async () => {
		const { cookie, userId } = await createTestUser(
			app,
			"bob@example.com",
			"hunter2-hunter2-hunter2"
		);

		const payload = {
			positions: { users: { x: 100, y: 200 } },
			sizes: { users: { width: 240, height: 180 } },
			frames: [],
			hidden: []
		};

		const response = await app.inject({
			method: "PUT",
			url: "/api/canvas-state",
			headers: { cookie, "content-type": "application/json" },
			payload: { signature: "postgres:users", payload }
		});

		expect(response.statusCode).toBe(200);
		const body = response.json() as { updatedAt?: string };
		expect(typeof body.updatedAt).toBe("string");
		// updatedAt doit être un ISO string parsable en Date.
		expect(Number.isNaN(new Date(body.updatedAt ?? "").getTime())).toBe(false);

		// Sanity DB : une seule row, matchant (userId, signature).
		const rows = await app.db.execute(
			sql`SELECT user_id, schema_signature, payload FROM "canvas_state"`
		);
		expect(rows.length).toBe(1);
		const row = rows[0] as {
			user_id: string;
			schema_signature: string;
			payload: unknown;
		};
		expect(row.user_id).toBe(userId);
		expect(row.schema_signature).toBe("postgres:users");
		expect(row.payload).toEqual(payload);
	});

	// ─── 4. PUT idempotent — mêmes (userId, signature) → UPDATE ───────
	test("PUT même signature payload différent → 200 + row updated (idempotent upsert)", async () => {
		const { cookie, userId } = await createTestUser(
			app,
			"carol@example.com",
			"another-strong-password-123"
		);

		const first = await app.inject({
			method: "PUT",
			url: "/api/canvas-state",
			headers: { cookie, "content-type": "application/json" },
			payload: {
				signature: "postgres:users",
				payload: { version: 1 }
			}
		});
		expect(first.statusCode).toBe(200);
		const firstUpdatedAt = (first.json() as { updatedAt: string }).updatedAt;

		// Deuxième PUT avec un payload différent — doit UPDATE (pas INSERT).
		// On attend 1ms pour garantir un `now()` distinct côté Postgres et
		// pouvoir vérifier que `updated_at` est bien refresh.
		await new Promise((r) => setTimeout(r, 5));

		const second = await app.inject({
			method: "PUT",
			url: "/api/canvas-state",
			headers: { cookie, "content-type": "application/json" },
			payload: {
				signature: "postgres:users",
				payload: { version: 2, extra: "data" }
			}
		});
		expect(second.statusCode).toBe(200);
		const secondUpdatedAt = (second.json() as { updatedAt: string }).updatedAt;
		expect(new Date(secondUpdatedAt).getTime()).toBeGreaterThanOrEqual(
			new Date(firstUpdatedAt).getTime()
		);

		// Toujours UNE seule row (upsert, pas double insert).
		const rows = await app.db.execute(
			sql`SELECT user_id, payload FROM "canvas_state"`
		);
		expect(rows.length).toBe(1);
		const row = rows[0] as { user_id: string; payload: unknown };
		expect(row.user_id).toBe(userId);
		expect(row.payload).toEqual({ version: 2, extra: "data" });
	});

	// ─── 5. GET après PUT → 200 payload identique ─────────────────────
	test("GET après PUT → 200 payload identique", async () => {
		const { cookie } = await createTestUser(
			app,
			"dave@example.com",
			"my-very-long-password-45"
		);

		const payload = {
			positions: { orders: { x: 10, y: 20 }, products: { x: 30, y: 40 } },
			hidden: ["invoices"]
		};

		const putResp = await app.inject({
			method: "PUT",
			url: "/api/canvas-state",
			headers: { cookie, "content-type": "application/json" },
			payload: { signature: "postgres:orders,products", payload }
		});
		expect(putResp.statusCode).toBe(200);
		const putUpdatedAt = (putResp.json() as { updatedAt: string }).updatedAt;

		const getResp = await app.inject({
			method: "GET",
			url: "/api/canvas-state?signature=postgres:orders,products",
			headers: { cookie }
		});
		expect(getResp.statusCode).toBe(200);
		const body = getResp.json() as { payload: unknown; updatedAt: string };
		expect(body.payload).toEqual(payload);
		expect(body.updatedAt).toBe(putUpdatedAt);
	});

	// ─── 6. DELETE → 204, GET suivant → 404 ───────────────────────────
	test("DELETE → 204, GET suivant → 404", async () => {
		const { cookie } = await createTestUser(
			app,
			"erin@example.com",
			"strong-password-erin-89"
		);

		// Setup : PUT une row.
		await app.inject({
			method: "PUT",
			url: "/api/canvas-state",
			headers: { cookie, "content-type": "application/json" },
			payload: {
				signature: "postgres:users",
				payload: { foo: "bar" }
			}
		});

		// DELETE.
		const delResp = await app.inject({
			method: "DELETE",
			url: "/api/canvas-state?signature=postgres:users",
			headers: { cookie }
		});
		expect(delResp.statusCode).toBe(204);
		// 204 ne doit renvoyer aucun body.
		expect(delResp.payload).toBe("");

		// GET suivant → 404.
		const getResp = await app.inject({
			method: "GET",
			url: "/api/canvas-state?signature=postgres:users",
			headers: { cookie }
		});
		expect(getResp.statusCode).toBe(404);

		// DB vide (pour ce user).
		const rows = await app.db.execute(
			sql`SELECT COUNT(*)::int AS n FROM "canvas_state"`
		);
		expect((rows[0] as { n: number }).n).toBe(0);
	});

	// ─── 7. Isolation entre users ─────────────────────────────────────
	test("un user ne peut ni lire ni delete le canvas d'un autre user", async () => {
		const alice = await createTestUser(
			app,
			"alice-iso@example.com",
			"alice-alice-alice-alice"
		);
		const mallory = await createTestUser(
			app,
			"mallory@example.com",
			"mallory-mallory-mallory"
		);

		// Alice crée un canvas.
		const alicePayload = { secret: "alice-only" };
		await app.inject({
			method: "PUT",
			url: "/api/canvas-state",
			headers: { cookie: alice.cookie, "content-type": "application/json" },
			payload: { signature: "postgres:users", payload: alicePayload }
		});

		// Mallory tente de lire → 404 (isolation via WHERE user_id).
		const malloryGet = await app.inject({
			method: "GET",
			url: "/api/canvas-state?signature=postgres:users",
			headers: { cookie: mallory.cookie }
		});
		expect(malloryGet.statusCode).toBe(404);

		// Mallory tente de delete → 204 (idempotent), mais la row d'Alice
		// est INTACTE en DB (WHERE user_id = mallory.id ne matche rien).
		const malloryDel = await app.inject({
			method: "DELETE",
			url: "/api/canvas-state?signature=postgres:users",
			headers: { cookie: mallory.cookie }
		});
		expect(malloryDel.statusCode).toBe(204);

		// Vérification cruciale : la row d'Alice existe toujours en DB.
		const rows = await app.db.execute(
			sql`SELECT user_id, payload FROM "canvas_state"`
		);
		expect(rows.length).toBe(1);
		const row = rows[0] as { user_id: string; payload: unknown };
		expect(row.user_id).toBe(alice.userId);
		expect(row.payload).toEqual(alicePayload);

		// Alice peut toujours lire son propre canvas.
		const aliceGet = await app.inject({
			method: "GET",
			url: "/api/canvas-state?signature=postgres:users",
			headers: { cookie: alice.cookie }
		});
		expect(aliceGet.statusCode).toBe(200);
		const body = aliceGet.json() as { payload: unknown };
		expect(body.payload).toEqual(alicePayload);
	});
});
