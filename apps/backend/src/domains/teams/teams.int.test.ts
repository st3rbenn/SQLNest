/**
 * Tests intégration C.21.1 — auto-création de la team « Personal » à la
 * signup + idempotence de `createPersonalTeam`.
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
import { createTestApp, truncateTunnelsAndAuth } from "../../utils/testapp";
import { createPersonalTeam, defaultTeamNameForUser } from "./create";
import { TEAM_SLUG_REGEX } from "./slug";

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

async function signup(
	app: FastifyInstance,
	email: string,
	password: string,
	name?: string
): Promise<{ userId: string }> {
	const res = await app.inject({
		method: "POST",
		url: "/api/auth/sign-up/email",
		headers: { "content-type": "application/json" },
		payload: { email, password, name: name ?? email.split("@")[0] }
	});
	if (res.statusCode !== 200) {
		throw new Error(`sign-up failed: ${res.statusCode} ${res.body}`);
	}
	const body = res.json() as { user?: { id?: string } };
	// biome-ignore lint/style/noNonNullAssertion: sign-up returns user
	return { userId: body.user!.id! };
}

describe.skipIf(!DATABASE_URL)("C.21.1 — team auto-signup", () => {
	let app: FastifyInstance;

	beforeAll(async () => {
		app = createTestApp({ withAuth: true, withTunnelRegistry: true });
		await app.ready();
	});

	afterAll(async () => {
		await app.close();
	});

	beforeEach(async () => {
		await truncateTunnelsAndAuth(app);
	});

	test("signup email/password → 1 team « <name>'s team » auto-créée", async () => {
		const { userId } = await signup(
			app,
			"alice-teams@example.com",
			"alice-teams-alice-teams-1",
			"Alice"
		);
		const teams = await app.db
			.select()
			.from(schema.team)
			.where(eq(schema.team.ownerId, userId));
		expect(teams.length).toBe(1);
		const first = teams[0];
		// biome-ignore lint/style/noNonNullAssertion: length checked
		expect(first!.ownerId).toBe(userId);
		// Format Notion — nom explicite qui différencie l'user (« Alice »)
		// de sa team (« Alice's team ») dans la sidebar.
		// biome-ignore lint/style/noNonNullAssertion: length checked
		expect(first!.name).toBe("Alice's team");
		// biome-ignore lint/style/noNonNullAssertion: length checked
		expect(first!.slug).toMatch(TEAM_SLUG_REGEX);
	});

	test("defaultTeamNameForUser : format « <shortName>'s team »", () => {
		expect(defaultTeamNameForUser("Alice")).toBe("Alice's team");
		// email complet → prend la partie avant @
		expect(defaultTeamNameForUser("anthonincolas@gmail.com")).toBe(
			"anthonincolas's team"
		);
		// vide → fallback
		expect(defaultTeamNameForUser("")).toBe("My team");
		expect(defaultTeamNameForUser(null)).toBe("My team");
	});

	test("createPersonalTeam est idempotent (2 appels = 1 team)", async () => {
		const { userId } = await signup(
			app,
			"idem@example.com",
			"idem-idem-idem-idem-idem-1"
		);
		// Le hook a déjà créé la team. Ré-appel direct → même team retournée,
		// pas de nouvelle row.
		const before = await app.db
			.select({ id: schema.team.id })
			.from(schema.team)
			.where(eq(schema.team.ownerId, userId));
		const firstId = before[0]?.id;
		expect(firstId).toBeDefined();
		const result = await createPersonalTeam(app.db, userId, "Personal");
		expect(result.wasCreated).toBe(false);
		expect(result.teamId).toBe(firstId);
		const after = await app.db
			.select({ id: schema.team.id })
			.from(schema.team)
			.where(eq(schema.team.ownerId, userId));
		expect(after.length).toBe(1);
	});

	test("DELETE user cascade → team supprimée", async () => {
		const { userId } = await signup(
			app,
			"cascade@example.com",
			"cascade-cascade-cascade-1"
		);
		const before = await app.db
			.select()
			.from(schema.team)
			.where(eq(schema.team.ownerId, userId));
		expect(before.length).toBe(1);
		await app.db.delete(schema.user).where(eq(schema.user.id, userId));
		const after = await app.db
			.select()
			.from(schema.team)
			.where(eq(schema.team.ownerId, userId));
		expect(after.length).toBe(0);
	});

	test("C.21.2 — db_connection est scopée team (isolation cross-team pour un même user)", async () => {
		const { userId } = await signup(
			app,
			"multi-team@example.com",
			"multi-team-multi-team-1"
		);
		// Le hook a créé « Personal ». On crée une 2ᵉ team pour simuler
		// un user avec 2 teams (V2 preview) — l'isolation doit tenir même
		// pour le même owner.
		const teamAlpha = (
			await app.db
				.select()
				.from(schema.team)
				.where(eq(schema.team.ownerId, userId))
		)[0];
		expect(teamAlpha).toBeDefined();
		const teamBeta = await app.db
			.insert(schema.team)
			.values({
				slug: "beta01",
				name: "Team Beta",
				ownerId: userId
			})
			.returning();
		const teamBetaId = teamBeta[0]?.id;
		expect(teamBetaId).toBeDefined();

		// Une db_connection avec le MÊME name « prod » dans chaque team →
		// autorisé par le nouvel index (team_id, name).
		await app.db.insert(schema.dbConnection).values([
			{
				userId,
				// biome-ignore lint/style/noNonNullAssertion: checked above
				teamId: teamAlpha!.id,
				name: "prod",
				cliFingerprint: "a".repeat(64),
				engine: "postgres"
			},
			{
				userId,
				// biome-ignore lint/style/noNonNullAssertion: checked above
				teamId: teamBetaId!,
				name: "prod",
				cliFingerprint: "b".repeat(64),
				engine: "postgres"
			}
		]);

		// Le lookup par team_id est strictement scopé.
		const alphaConns = await app.db
			.select({ id: schema.dbConnection.id })
			.from(schema.dbConnection)
			// biome-ignore lint/style/noNonNullAssertion: checked above
			.where(eq(schema.dbConnection.teamId, teamAlpha!.id));
		expect(alphaConns.length).toBe(1);
		const betaConns = await app.db
			.select({ id: schema.dbConnection.id })
			.from(schema.dbConnection)
			// biome-ignore lint/style/noNonNullAssertion: checked above
			.where(eq(schema.dbConnection.teamId, teamBetaId!));
		expect(betaConns.length).toBe(1);
		expect(alphaConns[0]?.id).not.toBe(betaConns[0]?.id);
	});

	test("C.21.2 — DELETE team cascade → db_connection supprimées", async () => {
		const { userId } = await signup(
			app,
			"cascade-team@example.com",
			"cascade-team-cascade-team"
		);
		const teamId = (
			await app.db
				.select()
				.from(schema.team)
				.where(eq(schema.team.ownerId, userId))
		)[0]?.id;
		expect(teamId).toBeDefined();
		await app.db.insert(schema.dbConnection).values({
			userId,
			// biome-ignore lint/style/noNonNullAssertion: checked above
			teamId: teamId!,
			name: "will-die",
			cliFingerprint: "c".repeat(64),
			engine: "postgres"
		});
		const before = await app.db
			.select()
			.from(schema.dbConnection)
			// biome-ignore lint/style/noNonNullAssertion: checked above
			.where(eq(schema.dbConnection.teamId, teamId!));
		expect(before.length).toBe(1);
		// biome-ignore lint/style/noNonNullAssertion: checked above
		await app.db.delete(schema.team).where(eq(schema.team.id, teamId!));
		const after = await app.db
			.select()
			.from(schema.dbConnection)
			// biome-ignore lint/style/noNonNullAssertion: checked above
			.where(eq(schema.dbConnection.teamId, teamId!));
		expect(after.length).toBe(0);
	});

	test("2 users signent → 2 teams isolées, slugs distincts", async () => {
		const a = await signup(
			app,
			"iso-a@example.com",
			"iso-a-iso-a-iso-a-iso-a-1"
		);
		const b = await signup(
			app,
			"iso-b@example.com",
			"iso-b-iso-b-iso-b-iso-b-1"
		);
		const teams = await app.db.select().from(schema.team);
		expect(teams.length).toBe(2);
		const slugs = teams.map((t) => t.slug);
		expect(new Set(slugs).size).toBe(2);
		const owners = teams.map((t) => t.ownerId).sort();
		expect(owners).toEqual([a.userId, b.userId].sort());
	});
});
