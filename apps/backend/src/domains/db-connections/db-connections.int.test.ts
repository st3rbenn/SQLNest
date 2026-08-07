/**
 * Tests intégration — `GET /api/db-connections`.
 *
 * Couvre : auth, isolation user, ordering desc active_since, colonnes
 * retournées SANS DSN (aucun secret ne fuit — la table `db_connection`
 * n'en contient de toute façon aucun, garanti par le test-guard
 * `db-schema-guard`).
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { schema } from "@sqlnest/db";
import { config as loadEnv } from "dotenv";
import type { FastifyInstance } from "fastify";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test
} from "vitest";
import dbConnectionsRoute from "../../routes/api/db-connections/root";
import { createTestApp, truncateTunnelsAndAuth } from "../../utils/testapp";
import { hashSha256Hex } from "../tunnels/pairing/crypto";

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

function getSessionCookie(
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
		throw new Error(`sign-up failed: ${signUp.statusCode}`);
	}
	const cookie = getSessionCookie(signUp.headers);
	const body = signUp.json() as { user?: { id?: string } };
	// biome-ignore lint/style/noNonNullAssertion: checked
	return { cookie, userId: body.user!.id! };
}

async function seedConnection(
	app: FastifyInstance,
	userId: string,
	name: string,
	overrides: { activeSince?: Date; engine?: string } = {}
): Promise<string> {
	const rows = await app.db
		.insert(schema.dbConnection)
		.values({
			userId,
			name,
			cliFingerprint: hashSha256Hex(`${name}-${userId}`),
			engine: overrides.engine ?? "postgres",
			...(overrides.activeSince ? { activeSince: overrides.activeSince } : {})
		})
		.returning({ id: schema.dbConnection.id });
	// biome-ignore lint/style/noNonNullAssertion: length checked
	return rows[0]!.id;
}

describe.skipIf(!DATABASE_URL)("GET /api/db-connections", () => {
	let app: FastifyInstance;

	beforeAll(async () => {
		app = createTestApp({ withAuth: true, withTunnelRegistry: true });
		await app.register(dbConnectionsRoute, { prefix: "/api/db-connections" });
		await app.ready();
	});

	afterAll(async () => {
		await app.close();
	});

	beforeEach(async () => {
		await truncateTunnelsAndAuth(app);
	});

	test("sans cookie → 401", async () => {
		const res = await app.inject({
			method: "GET",
			url: "/api/db-connections"
		});
		expect(res.statusCode).toBe(401);
	});

	test("user sans connection → { connections: [] }", async () => {
		const { cookie } = await createTestUser(
			app,
			"alice@example.com",
			"correct-horse-battery-staple"
		);
		const res = await app.inject({
			method: "GET",
			url: "/api/db-connections",
			headers: { cookie }
		});
		expect(res.statusCode).toBe(200);
		expect(res.json()).toEqual({ connections: [] });
	});

	test("liste les connections du user avec les bonnes colonnes", async () => {
		const { cookie, userId } = await createTestUser(
			app,
			"bob@example.com",
			"long-and-strong-password-12"
		);
		const id = await seedConnection(app, userId, "prod");

		const res = await app.inject({
			method: "GET",
			url: "/api/db-connections",
			headers: { cookie }
		});
		expect(res.statusCode).toBe(200);
		const body = res.json() as {
			connections: Array<{
				id: string;
				name: string;
				engine: string;
				cliFingerprint: string;
				engineMetadata: unknown;
				activeSince: string;
				lastSeenAt: string | null;
				createdAt: string;
			}>;
		};
		expect(body.connections.length).toBe(1);
		const conn = body.connections[0];
		// biome-ignore lint/style/noNonNullAssertion: length checked
		expect(conn!.id).toBe(id);
		// biome-ignore lint/style/noNonNullAssertion: length checked
		expect(conn!.name).toBe("prod");
		// biome-ignore lint/style/noNonNullAssertion: length checked
		expect(conn!.engine).toBe("postgres");
		// biome-ignore lint/style/noNonNullAssertion: length checked
		expect(conn!.cliFingerprint).toHaveLength(64);
		// biome-ignore lint/style/noNonNullAssertion: length checked
		expect(conn!.engineMetadata).toEqual({});
		// biome-ignore lint/style/noNonNullAssertion: length checked
		expect(typeof conn!.activeSince).toBe("string");
		// biome-ignore lint/style/noNonNullAssertion: length checked
		expect(conn!.lastSeenAt).toBeNull();

		// GARANTIE règle 1 sécu : jamais de DSN/password dans la réponse
		// (impossible de toute façon puisque la table n'en contient pas).
		const raw = JSON.stringify(body);
		expect(raw).not.toMatch(/postgres:\/\//);
		expect(raw).not.toMatch(/password|dsn/i);
	});

	test("ordering desc active_since (le plus récent d'abord)", async () => {
		const { cookie, userId } = await createTestUser(
			app,
			"carol@example.com",
			"carol-carol-carol-carol"
		);
		const past = new Date(Date.now() - 60_000);
		const recent = new Date();
		await seedConnection(app, userId, "old", { activeSince: past });
		await seedConnection(app, userId, "new", { activeSince: recent });

		const res = await app.inject({
			method: "GET",
			url: "/api/db-connections",
			headers: { cookie }
		});
		const body = res.json() as { connections: Array<{ name: string }> };
		expect(body.connections.map((c) => c.name)).toEqual(["new", "old"]);
	});

	test("isolation user — Alice ne voit pas les connections de Bob", async () => {
		const alice = await createTestUser(
			app,
			"alice-iso@example.com",
			"alice-iso-alice-iso-1"
		);
		const bob = await createTestUser(
			app,
			"bob-iso@example.com",
			"bob-iso-bob-iso-bob-1"
		);
		await seedConnection(app, alice.userId, "alice-prod");
		await seedConnection(app, bob.userId, "bob-prod");

		const aliceRes = await app.inject({
			method: "GET",
			url: "/api/db-connections",
			headers: { cookie: alice.cookie }
		});
		const aliceBody = aliceRes.json() as {
			connections: Array<{ name: string }>;
		};
		expect(aliceBody.connections.map((c) => c.name)).toEqual(["alice-prod"]);
	});
});
