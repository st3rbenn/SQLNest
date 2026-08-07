/**
 * Tests d'intégration — mode CI Bearer sur `POST /api/tunnels/authenticate-token`.
 *
 * Cadre : app fresh (auth + tunnels routes + api-tokens routes) — le flow
 * complet côté user est :
 *   1. Créer un API token via POST /api/api-tokens (auth cookie).
 *   2. Lancer le CLI avec `--token sn_...` : POST /api/tunnels/authenticate-token
 *      avec `Authorization: Bearer sn_...` et `{ cliPubkeyEd25519, deviceName }`.
 *   3. Récupérer `{ token, tunnelId, connectionId, expiresAt }` — la session
 *      tunnel est prête.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ed25519 } from "@noble/curves/ed25519.js";
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
import apiTokensRoute from "../../routes/api/api-tokens/root";
import tunnelsRoute from "../../routes/api/tunnels/root";
import { createTestApp, truncateTunnelsAndAuth } from "../../utils/testapp";
import { hashSha256Hex } from "./pairing/crypto";

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

/** Crée un API token via la route publique — retourne le clair one-shot. */
async function createApiTokenViaHttp(
	app: FastifyInstance,
	cookie: string,
	name: string
): Promise<{ id: string; token: string }> {
	const res = await app.inject({
		method: "POST",
		url: "/api/api-tokens",
		headers: {
			cookie,
			"content-type": "application/json",
			origin: "http://localhost:3000"
		},
		payload: { name }
	});
	if (res.statusCode !== 200) {
		throw new Error(`create-token failed: ${res.statusCode} ${res.payload}`);
	}
	return res.json() as { id: string; token: string };
}

function makeCliKeypair(): { pubkeyHex: string } {
	const priv = ed25519.utils.randomSecretKey();
	const pub = ed25519.getPublicKey(priv);
	return { pubkeyHex: Buffer.from(pub).toString("hex") };
}

describe.skipIf(!DATABASE_URL)(
	"POST /api/tunnels/authenticate-token (mode CI Bearer)",
	() => {
		let app: FastifyInstance;

		beforeAll(async () => {
			app = createTestApp({ withAuth: true });
			await app.register(apiTokensRoute, { prefix: "/api/api-tokens" });
			await app.register(tunnelsRoute, { prefix: "/api/tunnels" });
			await app.ready();
		});

		afterAll(async () => {
			await app.close();
		});

		beforeEach(async () => {
			await truncateTunnelsAndAuth(app);
		});

		test("sans header Authorization → 401", async () => {
			const { pubkeyHex } = makeCliKeypair();
			const res = await app.inject({
				method: "POST",
				url: "/api/tunnels/authenticate-token",
				headers: { "content-type": "application/json" },
				payload: { cliPubkeyEd25519: pubkeyHex, deviceName: "test" }
			});
			expect(res.statusCode).toBe(401);
		});

		test("Bearer sans prefix `sn_` (ex JWT) → 401", async () => {
			const { pubkeyHex } = makeCliKeypair();
			const res = await app.inject({
				method: "POST",
				url: "/api/tunnels/authenticate-token",
				headers: {
					"content-type": "application/json",
					authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.xyz"
				},
				payload: { cliPubkeyEd25519: pubkeyHex, deviceName: "test" }
			});
			expect(res.statusCode).toBe(401);
		});

		test("token inconnu → 401", async () => {
			const { pubkeyHex } = makeCliKeypair();
			const res = await app.inject({
				method: "POST",
				url: "/api/tunnels/authenticate-token",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer sn_${"a".repeat(64)}`
				},
				payload: { cliPubkeyEd25519: pubkeyHex, deviceName: "test" }
			});
			expect(res.statusCode).toBe(401);
		});

		test("token révoqué → 401", async () => {
			const { cookie } = await createTestUser(
				app,
				"alice@example.com",
				"correct-horse-battery-staple"
			);
			const { id, token } = await createApiTokenViaHttp(app, cookie, "ci");
			// Revoke.
			await app.inject({
				method: "DELETE",
				url: `/api/api-tokens/${id}`,
				headers: { cookie, origin: "http://localhost:3000" }
			});

			const { pubkeyHex } = makeCliKeypair();
			const res = await app.inject({
				method: "POST",
				url: "/api/tunnels/authenticate-token",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${token}`
				},
				payload: { cliPubkeyEd25519: pubkeyHex, deviceName: "test" }
			});
			expect(res.statusCode).toBe(401);
		});

		test("nom déjà pris par une db_connection → 409", async () => {
			const { cookie, userId } = await createTestUser(
				app,
				"bob@example.com",
				"long-and-strong-password-12"
			);
			const { token } = await createApiTokenViaHttp(app, cookie, "ci");
			// Seed une db_connection avec le nom.
			await app.db.insert(schema.dbConnection).values({
				userId,
				name: "prod",
				cliFingerprint: "0".repeat(64),
				engine: "postgres"
			});

			const { pubkeyHex } = makeCliKeypair();
			const res = await app.inject({
				method: "POST",
				url: "/api/tunnels/authenticate-token",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${token}`
				},
				payload: { cliPubkeyEd25519: pubkeyHex, deviceName: "prod" }
			});
			expect(res.statusCode).toBe(409);
		});

		test("happy path — INSERT conn + session + bump last_used_at", async () => {
			const { cookie, userId } = await createTestUser(
				app,
				"carol@example.com",
				"carol-carol-carol-carol"
			);
			const { id: apiTokenId, token } = await createApiTokenViaHttp(
				app,
				cookie,
				"ci"
			);
			const { pubkeyHex } = makeCliKeypair();

			const res = await app.inject({
				method: "POST",
				url: "/api/tunnels/authenticate-token",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${token}`
				},
				payload: { cliPubkeyEd25519: pubkeyHex, deviceName: "ci-runner" }
			});
			expect(res.statusCode).toBe(200);
			const body = res.json() as {
				token: string;
				tunnelId: string;
				connectionId: string;
				expiresAt: string;
			};
			expect(body.token).toMatch(/^tn_[0-9a-f]{64}$/);

			// db_connection créée avec bon user + name + fingerprint.
			const conns = await app.db
				.select()
				.from(schema.dbConnection)
				.where(eq(schema.dbConnection.id, body.connectionId));
			// biome-ignore lint/style/noNonNullAssertion: length checked
			expect(conns[0]!.userId).toBe(userId);
			// biome-ignore lint/style/noNonNullAssertion: length checked
			expect(conns[0]!.name).toBe("ci-runner");
			// biome-ignore lint/style/noNonNullAssertion: length checked
			expect(conns[0]!.cliFingerprint).toBe(hashSha256Hex(pubkeyHex));

			// tunnel_session avec hash correct.
			const sessions = await app.db
				.select()
				.from(schema.tunnelSession)
				.where(eq(schema.tunnelSession.id, body.tunnelId));
			// biome-ignore lint/style/noNonNullAssertion: length checked
			expect(sessions[0]!.hash).toBe(hashSha256Hex(body.token));

			// last_used_at bumpé sur l'api_token.
			const tokens = await app.db
				.select({ lastUsedAt: schema.apiToken.lastUsedAt })
				.from(schema.apiToken)
				.where(eq(schema.apiToken.id, apiTokenId));
			// biome-ignore lint/style/noNonNullAssertion: length checked
			expect(tokens[0]!.lastUsedAt).toBeInstanceOf(Date);
		});

		test("re-pairing avec même pubkey → réutilise db_connection (idempotent C.6)", async () => {
			const { cookie } = await createTestUser(
				app,
				"idempotent@example.com",
				"idempotent-idempotent-1234"
			);
			const { token } = await createApiTokenViaHttp(app, cookie, "ci");
			const cli = makeCliKeypair();

			const r1 = await app.inject({
				method: "POST",
				url: "/api/tunnels/authenticate-token",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${token}`
				},
				payload: { cliPubkeyEd25519: cli.pubkeyHex, deviceName: "first-name" }
			});
			expect(r1.statusCode).toBe(200);
			const b1 = r1.json() as { connectionId: string; tunnelId: string };

			// Deuxième authenticate avec MÊME pubkey mais un name différent
			// (l'user a peut-être tapé un autre nom au 2e pairing). Le
			// backend RÉUTILISE la db_connection existante — même id retourné,
			// name saisi silencieusement ignoré.
			const r2 = await app.inject({
				method: "POST",
				url: "/api/tunnels/authenticate-token",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${token}`
				},
				payload: { cliPubkeyEd25519: cli.pubkeyHex, deviceName: "second-name" }
			});
			expect(r2.statusCode).toBe(200);
			const b2 = r2.json() as { connectionId: string; tunnelId: string };

			// Même db_connection réutilisée.
			expect(b2.connectionId).toBe(b1.connectionId);
			// Mais une nouvelle session tunnel à chaque authenticate.
			expect(b2.tunnelId).not.toBe(b1.tunnelId);

			// Sanity DB : une seule row db_connection, name inchangé (first-name).
			const rows = await app.db
				.select({ name: schema.dbConnection.name })
				.from(schema.dbConnection);
			expect(rows.length).toBe(1);
			// biome-ignore lint/style/noNonNullAssertion: length checked
			expect(rows[0]!.name).toBe("first-name");
		});

		test("2 devices sur même token (noms différents) → 2 db_connections", async () => {
			const { cookie } = await createTestUser(
				app,
				"dave@example.com",
				"dave-dave-dave-dave-dave"
			);
			const { token } = await createApiTokenViaHttp(app, cookie, "ci");
			const cli1 = makeCliKeypair();
			const cli2 = makeCliKeypair();

			const r1 = await app.inject({
				method: "POST",
				url: "/api/tunnels/authenticate-token",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${token}`
				},
				payload: { cliPubkeyEd25519: cli1.pubkeyHex, deviceName: "dev1" }
			});
			expect(r1.statusCode).toBe(200);
			const r2 = await app.inject({
				method: "POST",
				url: "/api/tunnels/authenticate-token",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${token}`
				},
				payload: { cliPubkeyEd25519: cli2.pubkeyHex, deviceName: "dev2" }
			});
			expect(r2.statusCode).toBe(200);

			const b1 = r1.json() as { connectionId: string };
			const b2 = r2.json() as { connectionId: string };
			expect(b1.connectionId).not.toBe(b2.connectionId);
		});
	}
);
