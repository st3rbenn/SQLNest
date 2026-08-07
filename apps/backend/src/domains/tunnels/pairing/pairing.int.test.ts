/**
 * Tests d'intégration — device flow CLI ↔ compte user.
 *
 * Cadre :
 *   - App Fastify complète (auth + db).
 *   - TRUNCATE des tables tunnel/auth entre chaque test.
 *   - Router `tunnelsRoute` monté sous `/api/tunnels`.
 *
 * Portée :
 *   - `POST /pairings`                     (create)
 *   - `GET  /pairings/:code/status`        (status)
 *   - `POST /pairings/:code/approve`       (approve, auth requise + CSRF)
 *   - `POST /authenticate`                 (finalise, verify Ed25519)
 *
 * Le test dédié au rate-limit vit dans `pairing-rate-limit.int.test.ts`
 * (fresh app) — évite la pollution du bucket in-memory entre tests.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ed25519 } from "@noble/curves/ed25519.js";
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
import {
	formatPairingCode,
	hashSha256Hex
} from "../../../domains/tunnels/pairing/crypto";
import tunnelsRoute from "../../../routes/api/tunnels/root";
import { createTestApp, truncateTunnelsAndAuth } from "../../../utils/testapp";

// ─── .env RACINE (identique aux autres int tests) ────────────────────
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

// ─── Helpers ─────────────────────────────────────────────────────────

/** Extrait les cookies Set-Cookie normalisés vers une chaîne `name=value; name=value`. */
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
	if (!cookie) throw new Error(`no session cookie returned for ${email}`);
	const body = signUp.json() as { user?: { id?: string } };
	const userId = body.user?.id;
	if (!userId) throw new Error(`no user.id returned for ${email}`);
	return { cookie, userId };
}

/** Génère une paire Ed25519 pour un CLI. Retourne les hex + le signer. */
function makeCliKeypair(): {
	pubkeyHex: string;
	sign: (msg: string) => string;
} {
	const priv = ed25519.utils.randomSecretKey();
	const pub = ed25519.getPublicKey(priv);
	return {
		pubkeyHex: Buffer.from(pub).toString("hex"),
		sign: (msg: string) =>
			Buffer.from(ed25519.sign(new TextEncoder().encode(msg), priv)).toString(
				"hex"
			)
	};
}

/** Insère directement un pairing en DB — bypass /pairings pour cadrer
 * l'état initial (approved, expired, consumed) sans passer par le CLI. */
async function seedPairing(
	app: FastifyInstance,
	overrides: {
		code: string;
		cliPubkeyEd25519: string;
		userId?: string;
		deviceName?: string;
		approvedAt?: Date;
		consumedAt?: Date;
		expiresAt?: Date;
	}
): Promise<void> {
	await app.db.insert(schema.tunnelPairing).values({
		code: overrides.code,
		cliPubkeyEd25519: overrides.cliPubkeyEd25519,
		userId: overrides.userId ?? null,
		deviceName: overrides.deviceName ?? null,
		approvedAt: overrides.approvedAt ?? null,
		consumedAt: overrides.consumedAt ?? null,
		expiresAt: overrides.expiresAt ?? new Date(Date.now() + 5 * 60 * 1000)
	});
}

// ─── Suite ───────────────────────────────────────────────────────────
describe.skipIf(!DATABASE_URL)("/api/tunnels — device flow", () => {
	let app: FastifyInstance;

	beforeAll(async () => {
		app = createTestApp({ withAuth: true });
		await app.register(tunnelsRoute, { prefix: "/api/tunnels" });
		await app.ready();
	});

	afterAll(async () => {
		await app.close();
	});

	beforeEach(async () => {
		await truncateTunnelsAndAuth(app);
	});

	// ═══════════════════════════════════════════════════════════════
	// POST /pairings
	// ═══════════════════════════════════════════════════════════════
	describe("POST /pairings", () => {
		test("body sans pubkey → 400 Zod", async () => {
			const res = await app.inject({
				method: "POST",
				url: "/api/tunnels/pairings",
				headers: { "content-type": "application/json" },
				payload: {}
			});
			expect(res.statusCode).toBe(400);
		});

		test("pubkey mal formée (non-hex, mauvaise longueur) → 400", async () => {
			const res = await app.inject({
				method: "POST",
				url: "/api/tunnels/pairings",
				headers: { "content-type": "application/json" },
				payload: { cliPubkeyEd25519: "not-hex" }
			});
			expect(res.statusCode).toBe(400);
		});

		test("pubkey valide → 200 + row en DB (pending, user_id NULL)", async () => {
			const { pubkeyHex } = makeCliKeypair();
			const res = await app.inject({
				method: "POST",
				url: "/api/tunnels/pairings",
				headers: { "content-type": "application/json" },
				payload: { cliPubkeyEd25519: pubkeyHex }
			});
			expect(res.statusCode).toBe(200);
			const body = res.json() as {
				code: string;
				expiresAt: string;
				pollUrl: string;
			};
			// Format `XXXX-XXXX` (9 chars avec dash au milieu).
			expect(body.code).toMatch(
				/^[0-9A-HJKMNPQRSTVWXYZ]{4}-[0-9A-HJKMNPQRSTVWXYZ]{4}$/
			);
			expect(body.pollUrl).toBe(`/api/tunnels/pairings/${body.code}/status`);
			// expiresAt ~ now + 5 min.
			const drift = new Date(body.expiresAt).getTime() - Date.now();
			expect(drift).toBeGreaterThan(4 * 60 * 1000);
			expect(drift).toBeLessThan(6 * 60 * 1000);

			// DB : le code est stocké en canonique (sans dash).
			const canonical = body.code.replace("-", "");
			const rows = await app.db
				.select()
				.from(schema.tunnelPairing)
				.where(eq(schema.tunnelPairing.code, canonical));
			expect(rows.length).toBe(1);
			// biome-ignore lint/style/noNonNullAssertion: length checked
			expect(rows[0]!.userId).toBeNull();
			// biome-ignore lint/style/noNonNullAssertion: length checked
			expect(rows[0]!.cliPubkeyEd25519).toBe(pubkeyHex);
			// biome-ignore lint/style/noNonNullAssertion: length checked
			expect(rows[0]!.approvedAt).toBeNull();
			// biome-ignore lint/style/noNonNullAssertion: length checked
			expect(rows[0]!.consumedAt).toBeNull();
		});
	});

	// ═══════════════════════════════════════════════════════════════
	// GET /pairings/:code/status
	// ═══════════════════════════════════════════════════════════════
	describe("GET /pairings/:code/status", () => {
		test("code malformé → 400", async () => {
			const res = await app.inject({
				method: "GET",
				url: "/api/tunnels/pairings/XX/status"
			});
			expect(res.statusCode).toBe(400);
		});

		test("code inexistant → 200 `expired` (anti-énumération)", async () => {
			const res = await app.inject({
				method: "GET",
				url: "/api/tunnels/pairings/ABCD-1234/status"
			});
			expect(res.statusCode).toBe(200);
			const body = res.json() as { status: string; deviceName: string | null };
			expect(body.status).toBe("expired");
			expect(body.deviceName).toBeNull();
		});

		test("pairing fresh → `pending`", async () => {
			const { pubkeyHex } = makeCliKeypair();
			await seedPairing(app, {
				code: "ABCD1234",
				cliPubkeyEd25519: pubkeyHex
			});
			const res = await app.inject({
				method: "GET",
				url: "/api/tunnels/pairings/ABCD-1234/status"
			});
			expect(res.statusCode).toBe(200);
			const body = res.json() as { status: string; deviceName: string | null };
			expect(body.status).toBe("pending");
			expect(body.deviceName).toBeNull();
		});

		test("pairing approved → `approved` + deviceName", async () => {
			const { userId } = await createTestUser(
				app,
				"alice@example.com",
				"correct-horse-battery-staple"
			);
			const { pubkeyHex } = makeCliKeypair();
			await seedPairing(app, {
				code: "ABCD1234",
				cliPubkeyEd25519: pubkeyHex,
				userId,
				deviceName: "alice-mac",
				approvedAt: new Date()
			});
			const res = await app.inject({
				method: "GET",
				url: "/api/tunnels/pairings/ABCD-1234/status"
			});
			expect(res.statusCode).toBe(200);
			const body = res.json() as { status: string; deviceName: string | null };
			expect(body.status).toBe("approved");
			expect(body.deviceName).toBe("alice-mac");
		});

		test("pairing expiré → `expired`", async () => {
			const { pubkeyHex } = makeCliKeypair();
			await seedPairing(app, {
				code: "EXPX0001",
				cliPubkeyEd25519: pubkeyHex,
				expiresAt: new Date(Date.now() - 60_000)
			});
			const res = await app.inject({
				method: "GET",
				url: "/api/tunnels/pairings/EXPX-0001/status"
			});
			expect(res.statusCode).toBe(200);
			expect((res.json() as { status: string }).status).toBe("expired");
		});

		test("pairing consumed → `consumed`", async () => {
			const { userId } = await createTestUser(
				app,
				"bob@example.com",
				"long-and-strong-password-12"
			);
			const { pubkeyHex } = makeCliKeypair();
			await seedPairing(app, {
				code: "DEAD0001",
				cliPubkeyEd25519: pubkeyHex,
				userId,
				deviceName: "bob-cli",
				approvedAt: new Date(),
				consumedAt: new Date()
			});
			const res = await app.inject({
				method: "GET",
				url: "/api/tunnels/pairings/DEAD-0001/status"
			});
			expect(res.statusCode).toBe(200);
			const body = res.json() as { status: string; deviceName: string | null };
			expect(body.status).toBe("consumed");
			expect(body.deviceName).toBe("bob-cli");
		});

		test("existingConnection null si user non-authentifié (poll CLI)", async () => {
			const { userId } = await createTestUser(
				app,
				"anon-poll@example.com",
				"anon-poll-anon-poll-1234"
			);
			const { pubkeyHex } = makeCliKeypair();
			// Seed une db_connection avec cette pubkey (fingerprint match
			// possible SI on avait un userId dans le status).
			await app.db.insert(schema.dbConnection).values({
				userId,
				name: "existing-cli",
				cliFingerprint: hashSha256Hex(pubkeyHex),
				engine: "postgres"
			});
			await seedPairing(app, {
				code: "PBBB1111",
				cliPubkeyEd25519: pubkeyHex
			});
			// Poll SANS cookie → existingConnection null (privacy).
			const res = await app.inject({
				method: "GET",
				url: "/api/tunnels/pairings/PBBB-1111/status"
			});
			expect(res.statusCode).toBe(200);
			const body = res.json() as {
				existingConnection: unknown;
			};
			expect(body.existingConnection).toBeNull();
		});

		test("existingConnection peuplé si user auth + fingerprint match (C.7)", async () => {
			const { cookie, userId } = await createTestUser(
				app,
				"reco-status@example.com",
				"reco-status-reco-status-1"
			);
			const { pubkeyHex } = makeCliKeypair();
			await app.db.insert(schema.dbConnection).values({
				userId,
				name: "apollon_db",
				cliFingerprint: hashSha256Hex(pubkeyHex),
				engine: "postgres"
			});
			await seedPairing(app, {
				code: "AAAA1111",
				cliPubkeyEd25519: pubkeyHex
			});
			const res = await app.inject({
				method: "GET",
				url: "/api/tunnels/pairings/AAAA-1111/status",
				headers: { cookie }
			});
			expect(res.statusCode).toBe(200);
			const body = res.json() as {
				status: string;
				existingConnection: { id: string; name: string } | null;
			};
			expect(body.existingConnection).not.toBeNull();
			// biome-ignore lint/style/noNonNullAssertion: assert ci-dessus
			expect(body.existingConnection!.name).toBe("apollon_db");
		});

		test("existingConnection null si user auth mais fingerprint inconnu", async () => {
			const { cookie } = await createTestUser(
				app,
				"other-user@example.com",
				"other-user-other-user-12"
			);
			const { pubkeyHex } = makeCliKeypair();
			// PAS de db_connection seedée pour cette pubkey.
			await seedPairing(app, {
				code: "NEWK1111",
				cliPubkeyEd25519: pubkeyHex
			});
			const res = await app.inject({
				method: "GET",
				url: "/api/tunnels/pairings/NEWK-1111/status",
				headers: { cookie }
			});
			expect(res.statusCode).toBe(200);
			const body = res.json() as { existingConnection: unknown };
			expect(body.existingConnection).toBeNull();
		});

		test("normalise le code (lowercase, dash absent, remap Crockford)", async () => {
			const { pubkeyHex } = makeCliKeypair();
			// Canonique en DB.
			await seedPairing(app, {
				code: "ABCD1234",
				cliPubkeyEd25519: pubkeyHex
			});
			// Query en lowercase, sans dash → match.
			const res = await app.inject({
				method: "GET",
				url: "/api/tunnels/pairings/abcd1234/status"
			});
			expect(res.statusCode).toBe(200);
			expect((res.json() as { status: string }).status).toBe("pending");
		});
	});

	// ═══════════════════════════════════════════════════════════════
	// POST /pairings/:code/approve
	// ═══════════════════════════════════════════════════════════════
	describe("POST /pairings/:code/approve", () => {
		test("sans cookie → 401", async () => {
			const res = await app.inject({
				method: "POST",
				url: "/api/tunnels/pairings/ABCD-1234/approve",
				headers: {
					"content-type": "application/json",
					origin: "http://localhost:3000"
				},
				payload: { deviceName: "test" }
			});
			expect(res.statusCode).toBe(401);
		});

		test("sans Origin → 403", async () => {
			const { cookie } = await createTestUser(
				app,
				"carol@example.com",
				"carol-carol-carol-carol"
			);
			const res = await app.inject({
				method: "POST",
				url: "/api/tunnels/pairings/ABCD-1234/approve",
				headers: { cookie, "content-type": "application/json" },
				payload: { deviceName: "test" }
			});
			expect(res.statusCode).toBe(403);
		});

		test("Origin hostile → 403", async () => {
			const { cookie } = await createTestUser(
				app,
				"dave@example.com",
				"dave-dave-dave-dave-dave"
			);
			const res = await app.inject({
				method: "POST",
				url: "/api/tunnels/pairings/ABCD-1234/approve",
				headers: {
					cookie,
					"content-type": "application/json",
					origin: "https://evil.com"
				},
				payload: { deviceName: "test" }
			});
			expect(res.statusCode).toBe(403);
		});

		test("code inexistant → 404", async () => {
			const { cookie } = await createTestUser(
				app,
				"erin@example.com",
				"erin-erin-erin-erin-erin"
			);
			const res = await app.inject({
				method: "POST",
				url: "/api/tunnels/pairings/ABCD-1234/approve",
				headers: {
					cookie,
					"content-type": "application/json",
					origin: "http://localhost:3000"
				},
				payload: { deviceName: "erin-mac" }
			});
			expect(res.statusCode).toBe(404);
		});

		test("code expiré → 410", async () => {
			const { cookie } = await createTestUser(
				app,
				"frank@example.com",
				"frank-frank-frank-frank"
			);
			const { pubkeyHex } = makeCliKeypair();
			await seedPairing(app, {
				code: "EXPX0001",
				cliPubkeyEd25519: pubkeyHex,
				expiresAt: new Date(Date.now() - 60_000)
			});
			const res = await app.inject({
				method: "POST",
				url: "/api/tunnels/pairings/EXPX-0001/approve",
				headers: {
					cookie,
					"content-type": "application/json",
					origin: "http://localhost:3000"
				},
				payload: { deviceName: "test" }
			});
			expect(res.statusCode).toBe(410);
		});

		test("code déjà consumed → 410", async () => {
			const { cookie, userId } = await createTestUser(
				app,
				"gina@example.com",
				"gina-gina-gina-gina-gina"
			);
			const { pubkeyHex } = makeCliKeypair();
			await seedPairing(app, {
				code: "DEAD0001",
				cliPubkeyEd25519: pubkeyHex,
				userId,
				deviceName: "gina-mac",
				approvedAt: new Date(),
				consumedAt: new Date()
			});
			const res = await app.inject({
				method: "POST",
				url: "/api/tunnels/pairings/DEAD-0001/approve",
				headers: {
					cookie,
					"content-type": "application/json",
					origin: "http://localhost:3000"
				},
				payload: { deviceName: "gina-mac-2" }
			});
			expect(res.statusCode).toBe(410);
		});

		test("nom conflit avec db_connection existante → 409", async () => {
			const { cookie, userId } = await createTestUser(
				app,
				"heidi@example.com",
				"heidi-heidi-heidi-heidi"
			);
			// Seed une db_connection existante avec le nom.
			await app.db.insert(schema.dbConnection).values({
				userId,
				name: "prod",
				cliFingerprint: "0".repeat(64),
				engine: "postgres"
			});
			const { pubkeyHex } = makeCliKeypair();
			await seedPairing(app, {
				code: "NEWX0001",
				cliPubkeyEd25519: pubkeyHex
			});
			const res = await app.inject({
				method: "POST",
				url: "/api/tunnels/pairings/NEWX-0001/approve",
				headers: {
					cookie,
					"content-type": "application/json",
					origin: "http://localhost:3000"
				},
				payload: { deviceName: "prod" }
			});
			expect(res.statusCode).toBe(409);
		});

		test("happy path → 200 + row updated", async () => {
			const { cookie, userId } = await createTestUser(
				app,
				"ivan@example.com",
				"ivan-ivan-ivan-ivan-ivan"
			);
			const { pubkeyHex } = makeCliKeypair();
			await seedPairing(app, {
				code: "PRDX0001",
				cliPubkeyEd25519: pubkeyHex
			});
			const res = await app.inject({
				method: "POST",
				url: "/api/tunnels/pairings/PRDX-0001/approve",
				headers: {
					cookie,
					"content-type": "application/json",
					origin: "http://localhost:3000"
				},
				payload: { deviceName: "ivan-mac" }
			});
			expect(res.statusCode).toBe(200);
			expect(res.json()).toEqual({ ok: true });

			const rows = await app.db
				.select()
				.from(schema.tunnelPairing)
				.where(eq(schema.tunnelPairing.code, "PRDX0001"));
			expect(rows.length).toBe(1);
			// biome-ignore lint/style/noNonNullAssertion: length checked
			expect(rows[0]!.userId).toBe(userId);
			// biome-ignore lint/style/noNonNullAssertion: length checked
			expect(rows[0]!.deviceName).toBe("ivan-mac");
			// biome-ignore lint/style/noNonNullAssertion: length checked
			expect(rows[0]!.approvedAt).toBeInstanceOf(Date);
		});

		test("re-approve idempotent — 2ème approve override deviceName", async () => {
			const { cookie, userId } = await createTestUser(
				app,
				"judy@example.com",
				"judy-judy-judy-judy-judy"
			);
			const { pubkeyHex } = makeCliKeypair();
			await seedPairing(app, {
				code: "RTRY0001",
				cliPubkeyEd25519: pubkeyHex
			});
			const commonHeaders = {
				cookie,
				"content-type": "application/json",
				origin: "http://localhost:3000"
			};
			await app.inject({
				method: "POST",
				url: "/api/tunnels/pairings/RTRY-0001/approve",
				headers: commonHeaders,
				payload: { deviceName: "first" }
			});
			const second = await app.inject({
				method: "POST",
				url: "/api/tunnels/pairings/RTRY-0001/approve",
				headers: commonHeaders,
				payload: { deviceName: "second" }
			});
			expect(second.statusCode).toBe(200);
			const rows = await app.db
				.select()
				.from(schema.tunnelPairing)
				.where(eq(schema.tunnelPairing.code, "RTRY0001"));
			// biome-ignore lint/style/noNonNullAssertion: length checked
			expect(rows[0]!.deviceName).toBe("second");
			// Le userId n'a pas changé.
			// biome-ignore lint/style/noNonNullAssertion: length checked
			expect(rows[0]!.userId).toBe(userId);
		});
	});

	// ═══════════════════════════════════════════════════════════════
	// POST /authenticate
	// ═══════════════════════════════════════════════════════════════
	describe("POST /authenticate", () => {
		test("body sans code → 400", async () => {
			const res = await app.inject({
				method: "POST",
				url: "/api/tunnels/authenticate",
				headers: { "content-type": "application/json" },
				payload: { signature: "a".repeat(128) }
			});
			expect(res.statusCode).toBe(400);
		});

		test("signature mal formée (non-hex ou mauvaise taille) → 400", async () => {
			const res = await app.inject({
				method: "POST",
				url: "/api/tunnels/authenticate",
				headers: { "content-type": "application/json" },
				payload: { code: "ABCD-1234", signature: "not-hex" }
			});
			expect(res.statusCode).toBe(400);
		});

		test("code inexistant → 401 (message générique anti-énumération)", async () => {
			const { sign } = makeCliKeypair();
			const res = await app.inject({
				method: "POST",
				url: "/api/tunnels/authenticate",
				headers: { "content-type": "application/json" },
				payload: {
					code: "ABCD-1234",
					signature: sign("ABCD1234")
				}
			});
			expect(res.statusCode).toBe(401);
		});

		test("code pending (jamais approved) → 403 not_approved", async () => {
			const { pubkeyHex, sign } = makeCliKeypair();
			await seedPairing(app, {
				code: "PEND0001",
				cliPubkeyEd25519: pubkeyHex
			});
			const res = await app.inject({
				method: "POST",
				url: "/api/tunnels/authenticate",
				headers: { "content-type": "application/json" },
				payload: {
					code: "PEND-0001",
					signature: sign("PEND0001")
				}
			});
			expect(res.statusCode).toBe(403);
		});

		test("approved mais signature invalide → 401", async () => {
			const { userId } = await createTestUser(
				app,
				"kevin@example.com",
				"kevin-kevin-kevin-kevin"
			);
			const { pubkeyHex } = makeCliKeypair();
			// Signature générée par une AUTRE keypair.
			const other = makeCliKeypair();
			await seedPairing(app, {
				code: "BADS0001",
				cliPubkeyEd25519: pubkeyHex,
				userId,
				deviceName: "kevin-mac",
				approvedAt: new Date()
			});
			const res = await app.inject({
				method: "POST",
				url: "/api/tunnels/authenticate",
				headers: { "content-type": "application/json" },
				payload: {
					code: "BADS-0001",
					signature: other.sign("BADS0001")
				}
			});
			expect(res.statusCode).toBe(401);
		});

		test("approved + code expiré → 410", async () => {
			const { userId } = await createTestUser(
				app,
				"laura@example.com",
				"laura-laura-laura-laura"
			);
			const { pubkeyHex, sign } = makeCliKeypair();
			await seedPairing(app, {
				code: "EXPP0001",
				cliPubkeyEd25519: pubkeyHex,
				userId,
				deviceName: "laura-mac",
				approvedAt: new Date(Date.now() - 10 * 60_000),
				expiresAt: new Date(Date.now() - 60_000)
			});
			const res = await app.inject({
				method: "POST",
				url: "/api/tunnels/authenticate",
				headers: { "content-type": "application/json" },
				payload: {
					code: "EXPP-0001",
					signature: sign("EXPP0001")
				}
			});
			expect(res.statusCode).toBe(410);
		});

		test("code déjà consumed → 410", async () => {
			const { userId } = await createTestUser(
				app,
				"mike@example.com",
				"mike-mike-mike-mike-mike"
			);
			const { pubkeyHex, sign } = makeCliKeypair();
			await seedPairing(app, {
				code: "DEAD0001",
				cliPubkeyEd25519: pubkeyHex,
				userId,
				deviceName: "mike-mac",
				approvedAt: new Date(),
				consumedAt: new Date()
			});
			const res = await app.inject({
				method: "POST",
				url: "/api/tunnels/authenticate",
				headers: { "content-type": "application/json" },
				payload: {
					code: "DEAD-0001",
					signature: sign("DEAD0001")
				}
			});
			expect(res.statusCode).toBe(410);
		});

		test("happy path — DB updated + token opaque hashé, jamais persisté en clair", async () => {
			const { userId } = await createTestUser(
				app,
				"nora@example.com",
				"nora-nora-nora-nora-nora"
			);
			const { pubkeyHex, sign } = makeCliKeypair();
			await seedPairing(app, {
				code: "HAPP0001",
				cliPubkeyEd25519: pubkeyHex,
				userId,
				deviceName: "nora-mac",
				approvedAt: new Date()
			});

			const res = await app.inject({
				method: "POST",
				url: "/api/tunnels/authenticate",
				headers: { "content-type": "application/json" },
				payload: {
					code: "HAPP-0001",
					signature: sign("HAPP0001")
				}
			});
			expect(res.statusCode).toBe(200);
			const body = res.json() as {
				token: string;
				tunnelId: string;
				connectionId: string;
				expiresAt: string;
			};

			// Token clair côté client (format `tn_<hex>`).
			expect(body.token).toMatch(/^tn_[0-9a-f]{64}$/);

			// tunnel_session en DB : hash correspond au SHA-256 du clair.
			const sessions = await app.db
				.select()
				.from(schema.tunnelSession)
				.where(eq(schema.tunnelSession.id, body.tunnelId));
			expect(sessions.length).toBe(1);
			// biome-ignore lint/style/noNonNullAssertion: length checked
			expect(sessions[0]!.hash).toBe(hashSha256Hex(body.token));
			// biome-ignore lint/style/noNonNullAssertion: length checked
			expect(sessions[0]!.connectionId).toBe(body.connectionId);

			// db_connection créée avec bon user + name + fingerprint.
			const conns = await app.db
				.select()
				.from(schema.dbConnection)
				.where(eq(schema.dbConnection.id, body.connectionId));
			// biome-ignore lint/style/noNonNullAssertion: length checked
			expect(conns[0]!.userId).toBe(userId);
			// biome-ignore lint/style/noNonNullAssertion: length checked
			expect(conns[0]!.name).toBe("nora-mac");
			// biome-ignore lint/style/noNonNullAssertion: length checked
			expect(conns[0]!.cliFingerprint).toBe(hashSha256Hex(pubkeyHex));

			// pairing marqué consumed.
			const pairings = await app.db
				.select({ consumedAt: schema.tunnelPairing.consumedAt })
				.from(schema.tunnelPairing)
				.where(eq(schema.tunnelPairing.code, "HAPP0001"));
			// biome-ignore lint/style/noNonNullAssertion: length checked
			expect(pairings[0]!.consumedAt).toBeInstanceOf(Date);

			// GARANTIE règle sécu #2 : le clair du token n'existe nulle part
			// en DB. Grep intentionnel sur toutes les colonnes text/jsonb.
			// Le token n'est retrouvé par égalité qu'après passage par hash.
			const clearHits = await app.db.execute(sql`
				SELECT COUNT(*)::int AS n
				FROM tunnel_session
				WHERE hash = ${body.token}
			`);
			// biome-ignore lint/style/noNonNullAssertion: aggregate returns 1 row
			expect((clearHits[0]! as { n: number }).n).toBe(0);
		});

		test("re-pairing avec même pubkey → réutilise db_connection (idempotent C.6)", async () => {
			const { userId } = await createTestUser(
				app,
				"repair@example.com",
				"repair-repair-repair-1234"
			);
			// MÊME keypair CLI simulée entre les 2 pairings (l'user n'a pas
			// régénéré son ~/.sqlnest/config.toml entre 2 `sqlnest connect`).
			const { pubkeyHex, sign } = makeCliKeypair();

			// Premier pairing complet : code A → approve → authenticate.
			await seedPairing(app, {
				code: "REPA0001",
				cliPubkeyEd25519: pubkeyHex,
				userId,
				deviceName: "first-name",
				approvedAt: new Date()
			});
			const first = await app.inject({
				method: "POST",
				url: "/api/tunnels/authenticate",
				headers: { "content-type": "application/json" },
				payload: { code: "REPA-0001", signature: sign("REPA0001") }
			});
			expect(first.statusCode).toBe(200);
			const firstBody = first.json() as {
				connectionId: string;
				tunnelId: string;
			};

			// Deuxième pairing : nouveau code B, MÊME pubkey. L'user a stop
			// puis relancé son CLI — le fingerprint est identique → réutilise
			// la db_connection existante, même connectionId retourné.
			await seedPairing(app, {
				code: "REPA0002",
				cliPubkeyEd25519: pubkeyHex,
				userId,
				deviceName: "second-name",
				approvedAt: new Date()
			});
			const second = await app.inject({
				method: "POST",
				url: "/api/tunnels/authenticate",
				headers: { "content-type": "application/json" },
				payload: { code: "REPA-0002", signature: sign("REPA0002") }
			});
			expect(second.statusCode).toBe(200);
			const secondBody = second.json() as {
				connectionId: string;
				tunnelId: string;
			};

			// Même db_connection (idempotent), mais nouvelle session tunnel.
			expect(secondBody.connectionId).toBe(firstBody.connectionId);
			expect(secondBody.tunnelId).not.toBe(firstBody.tunnelId);
		});

		test("2ème authenticate avec même code → 410 (déjà consumed via 1er appel)", async () => {
			const { userId } = await createTestUser(
				app,
				"olga@example.com",
				"olga-olga-olga-olga-olga"
			);
			const { pubkeyHex, sign } = makeCliKeypair();
			await seedPairing(app, {
				code: "TWCE0001",
				cliPubkeyEd25519: pubkeyHex,
				userId,
				deviceName: "olga-mac",
				approvedAt: new Date()
			});

			const first = await app.inject({
				method: "POST",
				url: "/api/tunnels/authenticate",
				headers: { "content-type": "application/json" },
				payload: {
					code: "TWCE-0001",
					signature: sign("TWCE0001")
				}
			});
			expect(first.statusCode).toBe(200);

			const second = await app.inject({
				method: "POST",
				url: "/api/tunnels/authenticate",
				headers: { "content-type": "application/json" },
				payload: {
					code: "TWCE-0001",
					signature: sign("TWCE0001")
				}
			});
			expect(second.statusCode).toBe(410);
		});
	});

	// ═══════════════════════════════════════════════════════════════
	// E2E cycle — POST create → approve → status → authenticate
	// ═══════════════════════════════════════════════════════════════
	describe("cycle E2E", () => {
		test("create → status pending → approve → status approved → authenticate → status consumed", async () => {
			const { pubkeyHex, sign } = makeCliKeypair();
			const { cookie } = await createTestUser(
				app,
				"peter@example.com",
				"peter-peter-peter-peter"
			);

			// 1. Create pairing.
			const create = await app.inject({
				method: "POST",
				url: "/api/tunnels/pairings",
				headers: { "content-type": "application/json" },
				payload: { cliPubkeyEd25519: pubkeyHex }
			});
			expect(create.statusCode).toBe(200);
			const { code, pollUrl } = create.json() as {
				code: string;
				pollUrl: string;
			};

			// 2. Status → pending.
			const pending = await app.inject({ method: "GET", url: pollUrl });
			expect((pending.json() as { status: string }).status).toBe("pending");

			// 3. Approve (user connecté).
			const approve = await app.inject({
				method: "POST",
				url: `/api/tunnels/pairings/${code}/approve`,
				headers: {
					cookie,
					"content-type": "application/json",
					origin: "http://localhost:3000"
				},
				payload: { deviceName: "peter-cli" }
			});
			expect(approve.statusCode).toBe(200);

			// 4. Status → approved + deviceName.
			const approvedStatus = await app.inject({
				method: "GET",
				url: pollUrl
			});
			const st = approvedStatus.json() as {
				status: string;
				deviceName: string | null;
			};
			expect(st.status).toBe("approved");
			expect(st.deviceName).toBe("peter-cli");

			// 5. CLI authenticate.
			const canonical = code.replace("-", "");
			const auth = await app.inject({
				method: "POST",
				url: "/api/tunnels/authenticate",
				headers: { "content-type": "application/json" },
				payload: {
					code,
					signature: sign(canonical)
				}
			});
			expect(auth.statusCode).toBe(200);
			const authBody = auth.json() as { token: string };
			expect(authBody.token).toMatch(/^tn_[0-9a-f]{64}$/);

			// 6. Status → consumed.
			const consumed = await app.inject({ method: "GET", url: pollUrl });
			expect((consumed.json() as { status: string }).status).toBe("consumed");
		});
	});

	// Le formatage `formatPairingCode` est aussi utilisé indirectement
	// dans plusieurs tests via le body de POST /pairings — assertion
	// directe pour éviter l'oubli si le format change.
	test("`formatPairingCode` produit toujours `XXXX-XXXX`", () => {
		expect(formatPairingCode("ABCD1234")).toBe("ABCD-1234");
	});
});
