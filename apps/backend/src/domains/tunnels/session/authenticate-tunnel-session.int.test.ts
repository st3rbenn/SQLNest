/**
 * Tests intégration — `authenticateTunnelSession` (validation Bearer
 * `tn_...` sur la table `tunnel_session`).
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
import {
	createTestApp,
	ensureTeamForUser,
	truncateTunnelsAndAuth
} from "../../../utils/testapp";
import { hashSha256Hex } from "../pairing/crypto";
import { authenticateTunnelSession } from "./authenticate-tunnel-session";

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

async function seedUser(app: FastifyInstance, email: string): Promise<string> {
	const id = `tsu-${crypto.randomUUID()}`;
	await app.db.insert(schema.user).values({
		id,
		email,
		name: email.split("@")[0] ?? ""
	});
	return id;
}

async function seedConnection(
	app: FastifyInstance,
	userId: string,
	name: string,
	pubkeyHex: string
): Promise<string> {
	const teamId = await ensureTeamForUser(app, userId);
	const rows = await app.db
		.insert(schema.dbConnection)
		.values({
			userId,
			teamId,
			name,
			cliFingerprint: hashSha256Hex(pubkeyHex),
			engine: "postgres"
		})
		.returning({ id: schema.dbConnection.id });
	// biome-ignore lint/style/noNonNullAssertion: returning row exists
	return rows[0]!.id;
}

async function seedSession(
	app: FastifyInstance,
	connectionId: string,
	clearToken: string,
	overrides: { expiresAt?: Date; revokedAt?: Date | null } = {}
): Promise<string> {
	const rows = await app.db
		.insert(schema.tunnelSession)
		.values({
			connectionId,
			hash: hashSha256Hex(clearToken),
			expiresAt:
				overrides.expiresAt ?? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
			...(overrides.revokedAt !== undefined
				? { revokedAt: overrides.revokedAt }
				: {})
		})
		.returning({ id: schema.tunnelSession.id });
	// biome-ignore lint/style/noNonNullAssertion: returning row exists
	return rows[0]!.id;
}

describe.skipIf(!DATABASE_URL)("authenticateTunnelSession", () => {
	let app: FastifyInstance;

	beforeAll(async () => {
		app = createTestApp({ withAuth: true });
		await app.ready();
	});

	afterAll(async () => {
		await app.close();
	});

	beforeEach(async () => {
		await truncateTunnelsAndAuth(app);
	});

	test("token valide → match + bump last_used_at", async () => {
		const userId = await seedUser(app, "alice@example.com");
		const pubkey = "a".repeat(64);
		const connId = await seedConnection(app, userId, "prod", pubkey);
		const clear = `tn_${"b".repeat(64)}`;
		const sessId = await seedSession(app, connId, clear);

		const res = await authenticateTunnelSession(app.db, clear);
		expect(res).not.toBeNull();
		expect(res?.sessionId).toBe(sessId);
		expect(res?.connectionId).toBe(connId);
		expect(res?.userId).toBe(userId);
		expect(res?.cliFingerprint).toBe(hashSha256Hex(pubkey));

		// last_used_at bumpé.
		const rows = await app.db
			.select({ lastUsedAt: schema.tunnelSession.lastUsedAt })
			.from(schema.tunnelSession)
			.where(eq(schema.tunnelSession.id, sessId));
		// biome-ignore lint/style/noNonNullAssertion: length checked implicitly
		expect(rows[0]!.lastUsedAt).toBeInstanceOf(Date);
	});

	test("token inconnu → null", async () => {
		expect(
			await authenticateTunnelSession(app.db, `tn_${"0".repeat(64)}`)
		).toBeNull();
	});

	test("token révoqué → null", async () => {
		const userId = await seedUser(app, "bob@example.com");
		const connId = await seedConnection(app, userId, "prod", "a".repeat(64));
		const clear = `tn_${"c".repeat(64)}`;
		await seedSession(app, connId, clear, { revokedAt: new Date() });
		expect(await authenticateTunnelSession(app.db, clear)).toBeNull();
	});

	test("token expiré → null", async () => {
		const userId = await seedUser(app, "carol@example.com");
		const connId = await seedConnection(app, userId, "prod", "a".repeat(64));
		const clear = `tn_${"d".repeat(64)}`;
		await seedSession(app, connId, clear, {
			expiresAt: new Date(Date.now() - 60_000)
		});
		expect(await authenticateTunnelSession(app.db, clear)).toBeNull();
	});
});
