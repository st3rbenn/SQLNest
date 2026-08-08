/**
 * Tests intégration C.21.3 — routes team-scoped `/api/teams/*`.
 * Couvre :
 *   - GET /me, GET /me/default (fallback lazy), GET /:slug
 *   - Isolation cross-user (404 sur team d'un autre owner)
 *   - GET /:slug/db-connections + PUT /preview-snapshot team-scoped
 *   - GET /:slug/canvas-state (via team)
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { schema } from "@sqlnest/db";
import { config as loadEnv } from "dotenv";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test
} from "vitest";
import { hashSha256Hex } from "../../../domains/tunnels/pairing/crypto";
import {
	createTestApp,
	ensureTeamForUser,
	truncateTunnelsAndAuth
} from "../../../utils/testapp";
import teamsCanvasStateRoute from "./canvas-state";
import teamsDbConnectionsRoute from "./db-connections";
import teamsRoute from "./root";

const rootEnv = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"..",
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

function cookieOf(
	headers: Record<string, string | string[] | number | undefined>
): string {
	const raw = headers["set-cookie"];
	if (raw == null) return "";
	const arr = Array.isArray(raw) ? raw.map(String) : [String(raw)];
	return arr
		.map((c) => c.split(";")[0])
		.filter((p) => p != null && p.length > 0)
		.join("; ");
}

async function signup(
	app: FastifyInstance,
	email: string,
	password: string
): Promise<{ cookie: string; userId: string }> {
	const res = await app.inject({
		method: "POST",
		url: "/api/auth/sign-up/email",
		headers: { "content-type": "application/json" },
		payload: { email, password, name: email.split("@")[0] }
	});
	if (res.statusCode !== 200) {
		throw new Error(`sign-up failed: ${res.statusCode} ${res.body}`);
	}
	const cookie = cookieOf(res.headers);
	const body = res.json() as { user?: { id?: string } };
	// biome-ignore lint/style/noNonNullAssertion: sign-up returns user
	return { cookie, userId: body.user!.id! };
}

describe.skipIf(!DATABASE_URL)("C.21.3 — /api/teams routes", () => {
	let app: FastifyInstance;

	beforeAll(async () => {
		app = createTestApp({ withAuth: true, withTunnelRegistry: true });
		await app.register(teamsRoute, { prefix: "/api/teams" });
		await app.register(teamsDbConnectionsRoute, { prefix: "/api/teams" });
		await app.register(teamsCanvasStateRoute, { prefix: "/api/teams" });
		await app.ready();
	});

	afterAll(async () => {
		await app.close();
	});

	beforeEach(async () => {
		await truncateTunnelsAndAuth(app);
	});

	// ─── GET /me ─────────────────────────────────────────────────────
	test("GET /me sans cookie → 401", async () => {
		const res = await app.inject({ method: "GET", url: "/api/teams/me" });
		expect(res.statusCode).toBe(401);
	});

	test("GET /me renvoie la team perso auto-créée", async () => {
		const { cookie } = await signup(
			app,
			"me@example.com",
			"me-me-me-me-me-me-me-me-me"
		);
		const res = await app.inject({
			method: "GET",
			url: "/api/teams/me",
			headers: { cookie }
		});
		expect(res.statusCode).toBe(200);
		const body = res.json() as {
			teams: Array<{ id: string; slug: string; name: string }>;
		};
		expect(body.teams.length).toBe(1);
		expect(body.teams[0]?.slug).toMatch(/^[0-9a-f]{6}$/);
	});

	// ─── GET /me/default ─────────────────────────────────────────────
	test("GET /me/default renvoie la team perso existante", async () => {
		const { cookie } = await signup(
			app,
			"default1@example.com",
			"default1-default1-default1"
		);
		const res = await app.inject({
			method: "GET",
			url: "/api/teams/me/default",
			headers: { cookie }
		});
		expect(res.statusCode).toBe(200);
		const body = res.json() as { slug: string };
		expect(body.slug).toMatch(/^[0-9a-f]{6}$/);
	});

	test("GET /me/default crée lazy si absente (hook a raté)", async () => {
		const { cookie, userId } = await signup(
			app,
			"default2@example.com",
			"default2-default2-default2"
		);
		// Supprime manuellement la team pour simuler un hook raté.
		await app.db.delete(schema.team).where(eq(schema.team.ownerId, userId));
		const beforeCount = await app.db
			.select()
			.from(schema.team)
			.where(eq(schema.team.ownerId, userId));
		expect(beforeCount.length).toBe(0);
		const res = await app.inject({
			method: "GET",
			url: "/api/teams/me/default",
			headers: { cookie }
		});
		expect(res.statusCode).toBe(200);
		const afterCount = await app.db
			.select()
			.from(schema.team)
			.where(eq(schema.team.ownerId, userId));
		expect(afterCount.length).toBe(1);
	});

	// ─── GET /:slug ──────────────────────────────────────────────────
	test("GET /:slug owner → 200", async () => {
		const { cookie, userId } = await signup(
			app,
			"slug-owner@example.com",
			"slug-owner-slug-owner-1"
		);
		const t = await app.db
			.select()
			.from(schema.team)
			.where(eq(schema.team.ownerId, userId));
		const slug = t[0]?.slug;
		expect(slug).toBeDefined();
		const res = await app.inject({
			method: "GET",
			url: `/api/teams/${slug}`,
			headers: { cookie }
		});
		expect(res.statusCode).toBe(200);
	});

	test("GET /:slug d'un autre user → 404 (isolation)", async () => {
		const alice = await signup(
			app,
			"iso-alice@example.com",
			"iso-alice-iso-alice-iso-1"
		);
		const bob = await signup(
			app,
			"iso-bob@example.com",
			"iso-bob-iso-bob-iso-bob-1"
		);
		const bobTeam = await app.db
			.select()
			.from(schema.team)
			.where(eq(schema.team.ownerId, bob.userId));
		const bobSlug = bobTeam[0]?.slug;
		const res = await app.inject({
			method: "GET",
			url: `/api/teams/${bobSlug}`,
			headers: { cookie: alice.cookie }
		});
		expect(res.statusCode).toBe(404);
	});

	test("GET /:slug avec slug malformé → 404", async () => {
		const { cookie } = await signup(
			app,
			"bad-slug@example.com",
			"bad-slug-bad-slug-bad-1"
		);
		const res = await app.inject({
			method: "GET",
			url: "/api/teams/NOTAHEX/",
			headers: { cookie }
		});
		expect(res.statusCode).toBe(404);
	});

	// ─── GET /:slug/db-connections ───────────────────────────────────
	test("GET /:slug/db-connections liste team-scoped", async () => {
		const { cookie, userId } = await signup(
			app,
			"list-conn@example.com",
			"list-conn-list-conn-list-1"
		);
		const teamId = await ensureTeamForUser(app, userId);
		const t = await app.db
			.select()
			.from(schema.team)
			.where(eq(schema.team.ownerId, userId));
		const slug = t[0]?.slug;
		expect(slug).toBeDefined();
		await app.db.insert(schema.dbConnection).values({
			userId,
			teamId,
			name: "prod",
			cliFingerprint: hashSha256Hex(`prod-${userId}`),
			engine: "postgres"
		});
		const res = await app.inject({
			method: "GET",
			url: `/api/teams/${slug}/db-connections`,
			headers: { cookie }
		});
		expect(res.statusCode).toBe(200);
		const body = res.json() as { connections: Array<{ name: string }> };
		expect(body.connections.map((c) => c.name)).toEqual(["prod"]);
	});

	test("GET /:slug/db-connections d'une team d'un autre user → 404", async () => {
		const alice = await signup(
			app,
			"cx-alice@example.com",
			"cx-alice-cx-alice-cx-alice"
		);
		const bob = await signup(
			app,
			"cx-bob@example.com",
			"cx-bob-cx-bob-cx-bob-cx-b"
		);
		const bobTeam = await app.db
			.select()
			.from(schema.team)
			.where(eq(schema.team.ownerId, bob.userId));
		const bobSlug = bobTeam[0]?.slug;
		const res = await app.inject({
			method: "GET",
			url: `/api/teams/${bobSlug}/db-connections`,
			headers: { cookie: alice.cookie }
		});
		expect(res.statusCode).toBe(404);
	});

	// ─── PUT /:slug/db-connections/:id/preview-snapshot ──────────────
	test("PUT preview-snapshot team-scoped → 200 puis GET remonte le snapshot", async () => {
		const { cookie, userId } = await signup(
			app,
			"snap@example.com",
			"snap-snap-snap-snap-snap-1"
		);
		const teamId = await ensureTeamForUser(app, userId);
		const t = await app.db
			.select()
			.from(schema.team)
			.where(eq(schema.team.ownerId, userId));
		const slug = t[0]?.slug;
		const inserted = await app.db
			.insert(schema.dbConnection)
			.values({
				userId,
				teamId,
				name: "snap-conn",
				cliFingerprint: hashSha256Hex(`snap-${userId}`),
				engine: "postgres"
			})
			.returning({ id: schema.dbConnection.id });
		const connId = inserted[0]?.id;
		expect(connId).toBeDefined();
		const snapshot = {
			nodes: [{ id: "users", x: 0, y: 0, w: 100, h: 100 }],
			edges: [],
			frames: []
		};
		const putRes = await app.inject({
			method: "PUT",
			url: `/api/teams/${slug}/db-connections/${connId}/preview-snapshot`,
			headers: { "content-type": "application/json", cookie },
			payload: { snapshot }
		});
		expect(putRes.statusCode).toBe(200);
		const listRes = await app.inject({
			method: "GET",
			url: `/api/teams/${slug}/db-connections`,
			headers: { cookie }
		});
		const body = listRes.json() as {
			connections: Array<{ lastPreviewSnapshot: unknown }>;
		};
		expect(body.connections[0]?.lastPreviewSnapshot).toEqual(snapshot);
	});

	test("PUT preview-snapshot sur connection d'une autre team → 404", async () => {
		const alice = await signup(
			app,
			"snap-a@example.com",
			"snap-a-snap-a-snap-a-snap-"
		);
		const bob = await signup(
			app,
			"snap-b@example.com",
			"snap-b-snap-b-snap-b-snap-"
		);
		const bobTeamId = await ensureTeamForUser(app, bob.userId);
		const bobConn = await app.db
			.insert(schema.dbConnection)
			.values({
				userId: bob.userId,
				teamId: bobTeamId,
				name: "bob-db",
				cliFingerprint: hashSha256Hex(`bob-${bob.userId}`),
				engine: "postgres"
			})
			.returning({ id: schema.dbConnection.id });
		const aliceTeam = await app.db
			.select()
			.from(schema.team)
			.where(eq(schema.team.ownerId, alice.userId));
		const aliceSlug = aliceTeam[0]?.slug;
		const bobConnId = bobConn[0]?.id;
		const res = await app.inject({
			method: "PUT",
			url: `/api/teams/${aliceSlug}/db-connections/${bobConnId}/preview-snapshot`,
			headers: { "content-type": "application/json", cookie: alice.cookie },
			payload: {
				snapshot: { nodes: [], edges: [], frames: [] }
			}
		});
		expect(res.statusCode).toBe(404);
	});

	// ─── GET /:slug/canvas-state ─────────────────────────────────────
	test("GET /:slug/canvas-state?connectionId=X → 404 si connection pas dans la team", async () => {
		const alice = await signup(
			app,
			"cv-alice@example.com",
			"cv-alice-cv-alice-cv-al-1"
		);
		const bob = await signup(
			app,
			"cv-bob@example.com",
			"cv-bob-cv-bob-cv-bob-cv-b"
		);
		const bobTeamId = await ensureTeamForUser(app, bob.userId);
		const bobConn = await app.db
			.insert(schema.dbConnection)
			.values({
				userId: bob.userId,
				teamId: bobTeamId,
				name: "bob-cv",
				cliFingerprint: hashSha256Hex(`cvbob-${bob.userId}`),
				engine: "postgres"
			})
			.returning({ id: schema.dbConnection.id });
		const bobConnId = bobConn[0]?.id;
		const aliceTeam = await app.db
			.select()
			.from(schema.team)
			.where(eq(schema.team.ownerId, alice.userId));
		const aliceSlug = aliceTeam[0]?.slug;
		const res = await app.inject({
			method: "GET",
			url: `/api/teams/${aliceSlug}/canvas-state?connectionId=${bobConnId}`,
			headers: { cookie: alice.cookie }
		});
		expect(res.statusCode).toBe(404);
	});
});
