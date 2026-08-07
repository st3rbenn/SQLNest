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
 * saute proprement quand la base est absente (CI sans docker par exemple).
 *
 * ─── Modèle testé (C.5) ───────────────────────────────────────────────
 * canvas_state est rattaché à `(user_id, db_connection_id)` — un canvas
 * par (user × connection). Chaque test crée d'abord une db_connection
 * fake pour son user via le helper `createTestConnection`, puis exerce
 * les endpoints avec le connectionId retourné.
 */

import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { schema as dbSchema } from "@sqlnest/db";
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
import {
	createTestApp,
	ensureTeamForUser,
	truncateCanvasAndAuth
} from "../../utils/testapp";

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

process.env.AUTH_SECRET =
	process.env.AUTH_SECRET &&
	!/changeme|replace|placeholder/i.test(process.env.AUTH_SECRET)
		? process.env.AUTH_SECRET
		: "test-secret-super-long-value-32-chars-min-XX";

process.env.GOOGLE_CLIENT_ID ??= "";
process.env.GITHUB_CLIENT_ID ??= "";

process.env.BASE_URL = "http://localhost:4000";
process.env.TRUSTED_ORIGINS ??= "http://localhost:3000";

const DATABASE_URL = process.env.DATABASE_URL;

function getSetCookies(
	headers: Record<string, string | string[] | number | undefined>
): string[] {
	const raw = headers["set-cookie"];
	if (raw == null) return [];
	return Array.isArray(raw) ? raw.map(String) : [String(raw)];
}

function extractSessionCookie(setCookies: string[]): string {
	const pairs = setCookies
		.map((c) => c.split(";")[0])
		.filter((p) => p.length > 0);
	return pairs.join("; ");
}

/**
 * Helper — crée un user via Better Auth et retourne le cookie de session +
 * son `id` (utile pour les assertions cross-user).
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
	if (!cookie) throw new Error(`no session cookie returned for ${email}`);
	const body = signUp.json() as { user?: { id?: string } };
	const userId = body.user?.id;
	if (!userId) throw new Error(`no user.id returned for ${email}`);
	return { cookie, userId };
}

/**
 * Helper — crée une db_connection factice pour ce user et retourne son id.
 * Simule un pairing CLI sans passer par le tunnel réel : suffit pour
 * exercer canvas_state qui ne se soucie que de l'existence de la FK.
 */
async function createTestConnection(
	app: FastifyInstance,
	userId: string,
	name = `test-${Math.random().toString(36).slice(2, 8)}`
): Promise<string> {
	const teamId = await ensureTeamForUser(app, userId);
	const rows = await app.db
		.insert(dbSchema.dbConnection)
		.values({
			userId,
			teamId,
			name,
			cliFingerprint: randomBytes(32).toString("hex"),
			engine: "postgres"
		})
		.returning({ id: dbSchema.dbConnection.id });
	const row = rows[0];
	if (!row) throw new Error("createTestConnection: insert returned no row");
	return row.id;
}

describe.skipIf(!DATABASE_URL)("/api/canvas-state integration", () => {
	let app: FastifyInstance;

	beforeAll(async () => {
		app = createTestApp({ withAuth: true });
		await app.register(canvasStateRoute, { prefix: "/api/canvas-state" });
		await app.ready();
	});

	afterAll(async () => {
		await app.close();
		vi.clearAllMocks();
	});

	beforeEach(async () => {
		await truncateCanvasAndAuth(app);
	});

	// ─── 1. Guard : requireUser ───────────────────────────────────────
	test("GET sans cookie → 401", async () => {
		const response = await app.inject({
			method: "GET",
			url: `/api/canvas-state?connectionId=${randomUuid()}`
		});
		expect(response.statusCode).toBe(401);
		const body = response.json() as { message?: string };
		expect(body.message).toBe("Non authentifié");
	});

	// ─── 2. GET avec cookie mais connection jamais synchronisée → 404 ─
	test("GET avec cookie mais row inexistante → 404", async () => {
		const { cookie, userId } = await createTestUser(
			app,
			"alice@example.com",
			"correct-horse-battery-staple"
		);
		const connectionId = await createTestConnection(app, userId);

		const response = await app.inject({
			method: "GET",
			url: `/api/canvas-state?connectionId=${connectionId}`,
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
		const connectionId = await createTestConnection(app, userId);

		const payload = {
			positions: { users: { x: 100, y: 200 } },
			sizes: { users: { width: 240, height: 180 } },
			frames: [],
			hidden: []
		};

		const response = await app.inject({
			method: "PUT",
			url: "/api/canvas-state",
			headers: {
				cookie,
				"content-type": "application/json",
				origin: "http://localhost:3000"
			},
			payload: { connectionId, payload }
		});

		expect(response.statusCode).toBe(200);
		const body = response.json() as { updatedAt?: string };
		expect(typeof body.updatedAt).toBe("string");
		expect(Number.isNaN(new Date(body.updatedAt ?? "").getTime())).toBe(false);

		const rows = await app.db.execute(
			sql`SELECT user_id, db_connection_id, payload FROM "canvas_state"`
		);
		expect(rows.length).toBe(1);
		const row = rows[0] as {
			user_id: string;
			db_connection_id: string;
			payload: unknown;
		};
		expect(row.user_id).toBe(userId);
		expect(row.db_connection_id).toBe(connectionId);
		expect(row.payload).toEqual(payload);
	});

	// ─── 4. PUT idempotent — même connection → UPDATE ─────────────────
	test("PUT même connection payload différent → update (upsert)", async () => {
		const { cookie, userId } = await createTestUser(
			app,
			"carol@example.com",
			"another-strong-password-123"
		);
		const connectionId = await createTestConnection(app, userId);

		const first = await app.inject({
			method: "PUT",
			url: "/api/canvas-state",
			headers: {
				cookie,
				"content-type": "application/json",
				origin: "http://localhost:3000"
			},
			payload: { connectionId, payload: { version: 1 } }
		});
		expect(first.statusCode).toBe(200);
		const firstUpdatedAt = (first.json() as { updatedAt: string }).updatedAt;

		await new Promise((r) => setTimeout(r, 5));

		const second = await app.inject({
			method: "PUT",
			url: "/api/canvas-state",
			headers: {
				cookie,
				"content-type": "application/json",
				origin: "http://localhost:3000"
			},
			payload: { connectionId, payload: { version: 2, extra: "data" } }
		});
		expect(second.statusCode).toBe(200);
		const secondUpdatedAt = (second.json() as { updatedAt: string }).updatedAt;
		expect(new Date(secondUpdatedAt).getTime()).toBeGreaterThanOrEqual(
			new Date(firstUpdatedAt).getTime()
		);

		const rows = await app.db.execute(sql`SELECT payload FROM "canvas_state"`);
		expect(rows.length).toBe(1);
		expect((rows[0] as { payload: unknown }).payload).toEqual({
			version: 2,
			extra: "data"
		});
	});

	// ─── 5. GET après PUT → 200 avec le bon payload ───────────────────
	test("GET après PUT → 200 payload identique", async () => {
		const { cookie, userId } = await createTestUser(
			app,
			"dan@example.com",
			"yet-another-strong-pw-321"
		);
		const connectionId = await createTestConnection(app, userId);

		const payload = { positions: { foo: { x: 1, y: 2 } } };
		await app.inject({
			method: "PUT",
			url: "/api/canvas-state",
			headers: {
				cookie,
				"content-type": "application/json",
				origin: "http://localhost:3000"
			},
			payload: { connectionId, payload }
		});

		const response = await app.inject({
			method: "GET",
			url: `/api/canvas-state?connectionId=${connectionId}`,
			headers: { cookie }
		});
		expect(response.statusCode).toBe(200);
		const body = response.json() as { payload: unknown; updatedAt: string };
		expect(body.payload).toEqual(payload);
	});

	// ─── 6. DELETE → 204 puis GET suivant → 404 ────────────────────────
	test("DELETE → 204, GET suivant → 404", async () => {
		const { cookie, userId } = await createTestUser(
			app,
			"eve@example.com",
			"eve-strong-password-1234"
		);
		const connectionId = await createTestConnection(app, userId);

		await app.inject({
			method: "PUT",
			url: "/api/canvas-state",
			headers: {
				cookie,
				"content-type": "application/json",
				origin: "http://localhost:3000"
			},
			payload: { connectionId, payload: { any: "thing" } }
		});

		const del = await app.inject({
			method: "DELETE",
			url: `/api/canvas-state?connectionId=${connectionId}`,
			headers: { cookie, origin: "http://localhost:3000" }
		});
		expect(del.statusCode).toBe(204);

		const get = await app.inject({
			method: "GET",
			url: `/api/canvas-state?connectionId=${connectionId}`,
			headers: { cookie }
		});
		expect(get.statusCode).toBe(404);
	});

	// ─── 7. Isolation cross-user : Alice ne voit pas le canvas de Bob ─
	test("un user ne peut pas lire le canvas d'un autre user", async () => {
		const alice = await createTestUser(
			app,
			"alice-iso@ex.com",
			"pw-alice-1234567"
		);
		const bob = await createTestUser(
			app,
			"bob-iso@ex.com",
			"pw-bob-9876543210"
		);

		const aliceConn = await createTestConnection(app, alice.userId, "alice-db");
		const bobConn = await createTestConnection(app, bob.userId, "bob-db");

		await app.inject({
			method: "PUT",
			url: "/api/canvas-state",
			headers: {
				cookie: alice.cookie,
				"content-type": "application/json",
				origin: "http://localhost:3000"
			},
			payload: { connectionId: aliceConn, payload: { secret: "alice" } }
		});

		// Bob tente de GET le canvas d'Alice via son connectionId → 404
		// (isolation par user_id dans la WHERE : la row d'Alice n'est jamais
		// visible depuis Bob, même s'il connaissait l'aliceConn).
		const bobReadsAlice = await app.inject({
			method: "GET",
			url: `/api/canvas-state?connectionId=${aliceConn}`,
			headers: { cookie: bob.cookie }
		});
		expect(bobReadsAlice.statusCode).toBe(404);

		// Bob lit son propre canvas (vide) → 404 aussi, pas 200 avec payload d'Alice
		const bobReadsBob = await app.inject({
			method: "GET",
			url: `/api/canvas-state?connectionId=${bobConn}`,
			headers: { cookie: bob.cookie }
		});
		expect(bobReadsBob.statusCode).toBe(404);
	});

	// ─── 8. CSRF : PUT sans Origin → 403 ──────────────────────────────
	test("PUT sans Origin → 403 (CSRF defense-in-depth)", async () => {
		const { cookie, userId } = await createTestUser(
			app,
			"frank@example.com",
			"frank-strong-password-1234"
		);
		const connectionId = await createTestConnection(app, userId);

		const response = await app.inject({
			method: "PUT",
			url: "/api/canvas-state",
			headers: {
				cookie,
				"content-type": "application/json"
				// pas de header origin
			},
			payload: { connectionId, payload: {} }
		});
		expect(response.statusCode).toBe(403);
	});

	// ─── 9. CSRF : DELETE avec Origin hostile → 403 ───────────────────
	test("DELETE avec Origin hostile → 403 (CSRF defense-in-depth)", async () => {
		const { cookie, userId } = await createTestUser(
			app,
			"grace@example.com",
			"grace-strong-password-1234"
		);
		const connectionId = await createTestConnection(app, userId);

		const response = await app.inject({
			method: "DELETE",
			url: `/api/canvas-state?connectionId=${connectionId}`,
			headers: { cookie, origin: "https://evil.example.com" }
		});
		expect(response.statusCode).toBe(403);
	});
});

function randomUuid(): string {
	return crypto.randomUUID();
}
