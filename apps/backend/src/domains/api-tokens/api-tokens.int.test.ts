/**
 * Tests intégration — dashboard API tokens `/api/api-tokens/*`.
 *
 * Portée :
 *   - POST   / (auth + CSRF, one-shot display, conflit nom)
 *   - GET    / (isolation user, ordre desc, colonnes attendues)
 *   - DELETE /:id (auth + CSRF, soft-revoke, idempotence, cross-user)
 *
 * Le test dédié `authenticate-token.int.test.ts` couvre le mode CI.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { schema } from "@sqlnest/db";
import { config as loadEnv } from "dotenv";
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test
} from "vitest";
import apiTokensRoute from "../../routes/api/api-tokens/root";
import { createTestApp, truncateTunnelsAndAuth } from "../../utils/testapp";
import { hashApiToken } from "./crypto";

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
		throw new Error(
			`sign-up failed for ${email}: ${signUp.statusCode} ${signUp.payload}`
		);
	}
	const cookie = getSessionCookie(signUp.headers);
	if (!cookie) throw new Error(`no session cookie for ${email}`);
	const body = signUp.json() as { user?: { id?: string } };
	const userId = body.user?.id;
	if (!userId) throw new Error(`no user.id for ${email}`);
	return { cookie, userId };
}

describe.skipIf(!DATABASE_URL)("/api/api-tokens", () => {
	let app: FastifyInstance;

	beforeAll(async () => {
		app = createTestApp({ withAuth: true });
		await app.register(apiTokensRoute, { prefix: "/api/api-tokens" });
		await app.ready();
	});

	afterAll(async () => {
		await app.close();
	});

	beforeEach(async () => {
		await truncateTunnelsAndAuth(app);
	});

	// ═══════════════════════════════════════════════════════════════
	// POST /
	// ═══════════════════════════════════════════════════════════════
	describe("POST /", () => {
		test("sans cookie → 401", async () => {
			const res = await app.inject({
				method: "POST",
				url: "/api/api-tokens",
				headers: {
					"content-type": "application/json",
					origin: "http://localhost:3000"
				},
				payload: { name: "test" }
			});
			expect(res.statusCode).toBe(401);
		});

		test("sans Origin → 403", async () => {
			const { cookie } = await createTestUser(
				app,
				"alice@example.com",
				"correct-horse-battery-staple"
			);
			const res = await app.inject({
				method: "POST",
				url: "/api/api-tokens",
				headers: { cookie, "content-type": "application/json" },
				payload: { name: "test" }
			});
			expect(res.statusCode).toBe(403);
		});

		test("nom vide → 400 Zod", async () => {
			const { cookie } = await createTestUser(
				app,
				"bob@example.com",
				"bob-bob-bob-bob-bob-bob"
			);
			const res = await app.inject({
				method: "POST",
				url: "/api/api-tokens",
				headers: {
					cookie,
					"content-type": "application/json",
					origin: "http://localhost:3000"
				},
				payload: { name: "  " }
			});
			expect(res.statusCode).toBe(400);
		});

		test("happy path → 200 + token clair + hash correct en DB", async () => {
			const { cookie, userId } = await createTestUser(
				app,
				"carol@example.com",
				"carol-carol-carol-carol"
			);
			const res = await app.inject({
				method: "POST",
				url: "/api/api-tokens",
				headers: {
					cookie,
					"content-type": "application/json",
					origin: "http://localhost:3000"
				},
				payload: { name: "GitHub Actions" }
			});
			expect(res.statusCode).toBe(200);
			const body = res.json() as {
				id: string;
				name: string;
				prefix: string;
				token: string;
				createdAt: string;
			};
			expect(body.name).toBe("GitHub Actions");
			expect(body.token).toMatch(/^sn_[0-9a-f]{64}$/);
			expect(body.prefix).toBe(body.token.slice(0, 8));

			// DB : hash correspond au clair.
			const rows = await app.db
				.select()
				.from(schema.apiToken)
				.where(eq(schema.apiToken.id, body.id));
			expect(rows.length).toBe(1);
			// biome-ignore lint/style/noNonNullAssertion: length checked
			expect(rows[0]!.hash).toBe(hashApiToken(body.token));
			// biome-ignore lint/style/noNonNullAssertion: length checked
			expect(rows[0]!.userId).toBe(userId);
			// biome-ignore lint/style/noNonNullAssertion: length checked
			expect(rows[0]!.prefix).toBe(body.prefix);
			// biome-ignore lint/style/noNonNullAssertion: length checked
			expect(rows[0]!.lastUsedAt).toBeNull();
			// biome-ignore lint/style/noNonNullAssertion: length checked
			expect(rows[0]!.revokedAt).toBeNull();

			// GARANTIE règle 2 sécu : le clair n'existe pas en DB — un scan
			// direct sur `hash = <clear>` renvoie 0. Le token clair passe
			// UNIQUEMENT par la réponse HTTP.
			const clearHits = await app.db.execute(sql`
				SELECT COUNT(*)::int AS n
				FROM api_token
				WHERE hash = ${body.token}
			`);
			// biome-ignore lint/style/noNonNullAssertion: aggregate row
			expect((clearHits[0]! as { n: number }).n).toBe(0);
		});

		test("2 tokens même nom actifs → 409", async () => {
			const { cookie } = await createTestUser(
				app,
				"dave@example.com",
				"dave-dave-dave-dave-dave"
			);
			const headers = {
				cookie,
				"content-type": "application/json",
				origin: "http://localhost:3000"
			};
			const first = await app.inject({
				method: "POST",
				url: "/api/api-tokens",
				headers,
				payload: { name: "prod-ci" }
			});
			expect(first.statusCode).toBe(200);

			const second = await app.inject({
				method: "POST",
				url: "/api/api-tokens",
				headers,
				payload: { name: "prod-ci" }
			});
			expect(second.statusCode).toBe(409);
		});

		test("token révoqué → même nom réutilisable", async () => {
			const { cookie } = await createTestUser(
				app,
				"erin@example.com",
				"erin-erin-erin-erin-erin"
			);
			const headers = {
				cookie,
				"content-type": "application/json",
				origin: "http://localhost:3000"
			};

			const first = await app.inject({
				method: "POST",
				url: "/api/api-tokens",
				headers,
				payload: { name: "prod-ci" }
			});
			expect(first.statusCode).toBe(200);
			const { id: firstId } = first.json() as { id: string };

			// Revoke.
			const del = await app.inject({
				method: "DELETE",
				url: `/api/api-tokens/${firstId}`,
				headers: { cookie, origin: "http://localhost:3000" }
			});
			expect(del.statusCode).toBe(204);

			// Re-create avec même nom → OK.
			const second = await app.inject({
				method: "POST",
				url: "/api/api-tokens",
				headers,
				payload: { name: "prod-ci" }
			});
			expect(second.statusCode).toBe(200);
		});
	});

	// ═══════════════════════════════════════════════════════════════
	// GET /
	// ═══════════════════════════════════════════════════════════════
	describe("GET /", () => {
		test("sans cookie → 401", async () => {
			const res = await app.inject({ method: "GET", url: "/api/api-tokens" });
			expect(res.statusCode).toBe(401);
		});

		test("liste vide au démarrage", async () => {
			const { cookie } = await createTestUser(
				app,
				"frank@example.com",
				"frank-frank-frank-frank"
			);
			const res = await app.inject({
				method: "GET",
				url: "/api/api-tokens",
				headers: { cookie }
			});
			expect(res.statusCode).toBe(200);
			expect(res.json()).toEqual({ tokens: [] });
		});

		test("liste ordre desc + inclut révoqués + révèle jamais le clair", async () => {
			const { cookie } = await createTestUser(
				app,
				"gina@example.com",
				"gina-gina-gina-gina-gina"
			);
			const headers = {
				cookie,
				"content-type": "application/json",
				origin: "http://localhost:3000"
			};

			await app.inject({
				method: "POST",
				url: "/api/api-tokens",
				headers,
				payload: { name: "ci-1" }
			});
			// Petite pause pour garantir des created_at distincts.
			await new Promise((r) => setTimeout(r, 5));
			const t2 = await app.inject({
				method: "POST",
				url: "/api/api-tokens",
				headers,
				payload: { name: "ci-2" }
			});
			const { id: id2 } = t2.json() as { id: string };

			// Revoke t2.
			await app.inject({
				method: "DELETE",
				url: `/api/api-tokens/${id2}`,
				headers: { cookie, origin: "http://localhost:3000" }
			});

			const list = await app.inject({
				method: "GET",
				url: "/api/api-tokens",
				headers: { cookie }
			});
			const body = list.json() as {
				tokens: Array<{
					name: string;
					prefix: string;
					revokedAt: string | null;
				}>;
			};
			expect(body.tokens.length).toBe(2);
			// biome-ignore lint/style/noNonNullAssertion: length checked
			expect(body.tokens[0]!.name).toBe("ci-2");
			// biome-ignore lint/style/noNonNullAssertion: length checked
			expect(body.tokens[0]!.revokedAt).not.toBeNull();
			// biome-ignore lint/style/noNonNullAssertion: length checked
			expect(body.tokens[1]!.name).toBe("ci-1");
			// biome-ignore lint/style/noNonNullAssertion: length checked
			expect(body.tokens[1]!.revokedAt).toBeNull();

			// GARANTIE : le clair n'est jamais dans la réponse GET. On stringify
			// l'ensemble et on vérifie qu'aucune clé `token` ni de valeur
			// commençant par `sn_` ne fuit.
			const raw = JSON.stringify(body);
			expect(raw).not.toMatch(/"token"/);
			// Les prefixes commencent par `sn_` mais font 8 chars — n'a que
			// 5 chars d'entropie, insuffisant pour recover.
			for (const t of body.tokens) {
				expect(t.prefix.length).toBe(8);
			}
		});

		test("isolation user — Alice ne voit pas les tokens de Bob", async () => {
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
			const originHdr = { origin: "http://localhost:3000" };

			await app.inject({
				method: "POST",
				url: "/api/api-tokens",
				headers: {
					cookie: alice.cookie,
					"content-type": "application/json",
					...originHdr
				},
				payload: { name: "alice-ci" }
			});
			await app.inject({
				method: "POST",
				url: "/api/api-tokens",
				headers: {
					cookie: bob.cookie,
					"content-type": "application/json",
					...originHdr
				},
				payload: { name: "bob-ci" }
			});

			const aliceList = await app.inject({
				method: "GET",
				url: "/api/api-tokens",
				headers: { cookie: alice.cookie }
			});
			const aliceBody = aliceList.json() as {
				tokens: Array<{ name: string }>;
			};
			expect(aliceBody.tokens.length).toBe(1);
			// biome-ignore lint/style/noNonNullAssertion: length checked
			expect(aliceBody.tokens[0]!.name).toBe("alice-ci");
		});
	});

	// ═══════════════════════════════════════════════════════════════
	// DELETE /:id
	// ═══════════════════════════════════════════════════════════════
	describe("DELETE /:id", () => {
		async function createOneToken(
			cookie: string
		): Promise<{ id: string; token: string }> {
			const res = await app.inject({
				method: "POST",
				url: "/api/api-tokens",
				headers: {
					cookie,
					"content-type": "application/json",
					origin: "http://localhost:3000"
				},
				payload: { name: `t-${crypto.randomUUID()}` }
			});
			return res.json() as { id: string; token: string };
		}

		test("sans cookie → 401", async () => {
			const id = crypto.randomUUID();
			const res = await app.inject({
				method: "DELETE",
				url: `/api/api-tokens/${id}`,
				headers: { origin: "http://localhost:3000" }
			});
			expect(res.statusCode).toBe(401);
		});

		test("sans Origin → 403", async () => {
			const { cookie } = await createTestUser(
				app,
				"heidi@example.com",
				"heidi-heidi-heidi-heidi"
			);
			const { id } = await createOneToken(cookie);
			const res = await app.inject({
				method: "DELETE",
				url: `/api/api-tokens/${id}`,
				headers: { cookie }
			});
			expect(res.statusCode).toBe(403);
		});

		test("uuid invalide → 400", async () => {
			const { cookie } = await createTestUser(
				app,
				"ivan@example.com",
				"ivan-ivan-ivan-ivan-ivan"
			);
			const res = await app.inject({
				method: "DELETE",
				url: "/api/api-tokens/not-a-uuid",
				headers: { cookie, origin: "http://localhost:3000" }
			});
			expect(res.statusCode).toBe(400);
		});

		test("id inconnu → 404", async () => {
			const { cookie } = await createTestUser(
				app,
				"judy@example.com",
				"judy-judy-judy-judy-judy"
			);
			const res = await app.inject({
				method: "DELETE",
				url: `/api/api-tokens/${crypto.randomUUID()}`,
				headers: { cookie, origin: "http://localhost:3000" }
			});
			expect(res.statusCode).toBe(404);
		});

		test("happy path → 204 + revokedAt renseigné", async () => {
			const { cookie } = await createTestUser(
				app,
				"kevin@example.com",
				"kevin-kevin-kevin-kevin"
			);
			const { id } = await createOneToken(cookie);
			const res = await app.inject({
				method: "DELETE",
				url: `/api/api-tokens/${id}`,
				headers: { cookie, origin: "http://localhost:3000" }
			});
			expect(res.statusCode).toBe(204);
			expect(res.payload).toBe("");

			const rows = await app.db
				.select()
				.from(schema.apiToken)
				.where(eq(schema.apiToken.id, id));
			// biome-ignore lint/style/noNonNullAssertion: length checked
			expect(rows[0]!.revokedAt).toBeInstanceOf(Date);
		});

		test("idempotent — 2ème DELETE → 204 (state final = révoqué)", async () => {
			const { cookie } = await createTestUser(
				app,
				"laura@example.com",
				"laura-laura-laura-laura"
			);
			const { id } = await createOneToken(cookie);
			const headers = { cookie, origin: "http://localhost:3000" };

			const first = await app.inject({
				method: "DELETE",
				url: `/api/api-tokens/${id}`,
				headers
			});
			expect(first.statusCode).toBe(204);

			const second = await app.inject({
				method: "DELETE",
				url: `/api/api-tokens/${id}`,
				headers
			});
			expect(second.statusCode).toBe(204);
		});

		test("cross-user — Mallory tente delete un token d'Alice → 404", async () => {
			const alice = await createTestUser(
				app,
				"alice-xrev@example.com",
				"alice-xrev-alice-xrev-1"
			);
			const mallory = await createTestUser(
				app,
				"mallory-xrev@example.com",
				"mallory-xrev-mallory-1"
			);
			const { id } = await createOneToken(alice.cookie);

			const res = await app.inject({
				method: "DELETE",
				url: `/api/api-tokens/${id}`,
				headers: { cookie: mallory.cookie, origin: "http://localhost:3000" }
			});
			expect(res.statusCode).toBe(404);

			// Alice's token intact.
			const rows = await app.db
				.select()
				.from(schema.apiToken)
				.where(eq(schema.apiToken.id, id));
			// biome-ignore lint/style/noNonNullAssertion: length checked
			expect(rows[0]!.revokedAt).toBeNull();
		});
	});
});
