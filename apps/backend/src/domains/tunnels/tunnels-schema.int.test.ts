/**
 * Tests d'intégration — contraintes DB + TTL des 3 tables du Bloc CLI :
 * `api_token`, `tunnel_pairing`, `db_connection`.
 *
 * ─── But ──────────────────────────────────────────────────────────────
 * Vérifier au niveau du storage (pas des routes — les routes viennent
 * en Bloc 2/3) que :
 *   - les contraintes d'unicité sont bien en place (hash, (user_id, name),
 *     index partiel sur revoked_at),
 *   - le cycle de vie du pairing (pending → approved → consumed) tient,
 *   - le TTL `expires_at` est queryable (permet la purge cron),
 *   - la cascade FK `user → * ` fonctionne (RGPD : DELETE user vide
 *     tokens/pairings/connections).
 *
 * Colocalisé dans `domains/tunnels/` comme les futures routes du Bloc 2.
 *
 * ─── Isolation ─────────────────────────────────────────────────────────
 * `beforeEach` TRUNCATE via `truncateTunnelsAndAuth` — un test = un état
 * DB propre. Refuse de tourner contre une DB sans "test" dans l'URL
 * (garde intégrée à `assertTestDatabase`).
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { schema } from "@sqlnest/db";
import { config as loadEnv } from "dotenv";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
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

// Charge le .env RACINE avant tout register (même pattern que
// canvas-state.int.test.ts).
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

/** Insert direct d'un `user` (bypass Better Auth — on ne teste pas l'auth
 * ici, on teste le schéma). L'id user est `text` — on utilise un UUID
 * lisible pour faciliter le debug. */
async function seedUser(app: FastifyInstance, email: string): Promise<string> {
	const id = `test-${crypto.randomUUID()}`;
	await app.db.insert(schema.user).values({
		id,
		email,
		name: email.split("@")[0] ?? ""
	});
	return id;
}

describe.skipIf(!DATABASE_URL)("tunnels schema — contraintes DB", () => {
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

	// ─── api_token ────────────────────────────────────────────────────
	describe("api_token", () => {
		test("INSERT valide → row présente avec defaults corrects", async () => {
			const userId = await seedUser(app, "alice@example.com");

			await app.db.insert(schema.apiToken).values({
				userId,
				name: "GitHub Actions",
				hash: "a".repeat(64),
				prefix: "sn_1a2b"
			});

			const rows = await app.db
				.select()
				.from(schema.apiToken)
				.where(eq(schema.apiToken.userId, userId));

			expect(rows.length).toBe(1);
			const row = rows[0];
			// biome-ignore lint/style/noNonNullAssertion: length checked above
			expect(row!.name).toBe("GitHub Actions");
			// biome-ignore lint/style/noNonNullAssertion: length checked above
			expect(row!.hash).toBe("a".repeat(64));
			// biome-ignore lint/style/noNonNullAssertion: length checked above
			expect(row!.prefix).toBe("sn_1a2b");
			// biome-ignore lint/style/noNonNullAssertion: length checked above
			expect(row!.lastUsedAt).toBeNull();
			// biome-ignore lint/style/noNonNullAssertion: length checked above
			expect(row!.revokedAt).toBeNull();
			// biome-ignore lint/style/noNonNullAssertion: length checked above
			expect(row!.createdAt).toBeInstanceOf(Date);
		});

		test("unicité `hash` — deux tokens avec le même hash → violation", async () => {
			const alice = await seedUser(app, "alice@example.com");
			const bob = await seedUser(app, "bob@example.com");
			const sharedHash = "b".repeat(64);

			await app.db.insert(schema.apiToken).values({
				userId: alice,
				name: "alice-ci",
				hash: sharedHash,
				prefix: "sn_bbbb"
			});

			await expect(
				app.db.insert(schema.apiToken).values({
					userId: bob,
					name: "bob-ci",
					hash: sharedHash,
					prefix: "sn_bbbb"
				})
			).rejects.toThrow(/api_token_hash_unique|duplicate key/i);
		});

		test("unicité partielle (user_id, name) — actif seulement", async () => {
			const userId = await seedUser(app, "carol@example.com");

			// Token actif "prod-ci".
			await app.db.insert(schema.apiToken).values({
				userId,
				name: "prod-ci",
				hash: "c".repeat(64),
				prefix: "sn_cccc"
			});

			// Deuxième "prod-ci" ACTIF → refus.
			await expect(
				app.db.insert(schema.apiToken).values({
					userId,
					name: "prod-ci",
					hash: "d".repeat(64),
					prefix: "sn_dddd"
				})
			).rejects.toThrow(/api_token_user_name_active_unique|duplicate key/i);

			// Révoque le premier.
			await app.db
				.update(schema.apiToken)
				.set({ revokedAt: new Date() })
				.where(
					and(
						eq(schema.apiToken.userId, userId),
						eq(schema.apiToken.name, "prod-ci")
					)
				);

			// Nouveau "prod-ci" ACTIF → OK maintenant.
			await expect(
				app.db.insert(schema.apiToken).values({
					userId,
					name: "prod-ci",
					hash: "e".repeat(64),
					prefix: "sn_eeee"
				})
			).resolves.not.toThrow();

			// Sanity : 2 rows au total (1 révoqué + 1 actif).
			const rows = await app.db
				.select()
				.from(schema.apiToken)
				.where(eq(schema.apiToken.userId, userId));
			expect(rows.length).toBe(2);
		});

		test("DELETE user → CASCADE vide les api_token", async () => {
			const userId = await seedUser(app, "dave@example.com");
			await app.db.insert(schema.apiToken).values({
				userId,
				name: "some-token",
				hash: "f".repeat(64),
				prefix: "sn_ffff"
			});

			await app.db.delete(schema.user).where(eq(schema.user.id, userId));

			const rows = await app.db
				.select()
				.from(schema.apiToken)
				.where(eq(schema.apiToken.userId, userId));
			expect(rows.length).toBe(0);
		});
	});

	// ─── tunnel_pairing ───────────────────────────────────────────────
	describe("tunnel_pairing", () => {
		const cliPubkey = "1".repeat(64);
		const futureExpiry = () => new Date(Date.now() + 5 * 60 * 1000);
		const pastExpiry = () => new Date(Date.now() - 60 * 1000);

		test("INSERT pending (user_id NULL, non-approved, non-consumed)", async () => {
			await app.db.insert(schema.tunnelPairing).values({
				code: "ABCD-1234",
				cliPubkeyEd25519: cliPubkey,
				expiresAt: futureExpiry()
			});

			const rows = await app.db
				.select()
				.from(schema.tunnelPairing)
				.where(eq(schema.tunnelPairing.code, "ABCD-1234"));

			expect(rows.length).toBe(1);
			const row = rows[0];
			// biome-ignore lint/style/noNonNullAssertion: length checked above
			expect(row!.userId).toBeNull();
			// biome-ignore lint/style/noNonNullAssertion: length checked above
			expect(row!.approvedAt).toBeNull();
			// biome-ignore lint/style/noNonNullAssertion: length checked above
			expect(row!.consumedAt).toBeNull();
			// biome-ignore lint/style/noNonNullAssertion: length checked above
			expect(row!.cliPubkeyEd25519).toBe(cliPubkey);
		});

		test("PK unicité — même code inséré 2× → refus", async () => {
			await app.db.insert(schema.tunnelPairing).values({
				code: "EFGH-5678",
				cliPubkeyEd25519: cliPubkey,
				expiresAt: futureExpiry()
			});

			await expect(
				app.db.insert(schema.tunnelPairing).values({
					code: "EFGH-5678",
					cliPubkeyEd25519: "2".repeat(64),
					expiresAt: futureExpiry()
				})
			).rejects.toThrow(/tunnel_pairing_pkey|duplicate key/i);
		});

		test("query `expires_at > now()` filtre les pairings expirés", async () => {
			await app.db.insert(schema.tunnelPairing).values([
				{
					code: "ALIVE-001",
					cliPubkeyEd25519: cliPubkey,
					expiresAt: futureExpiry()
				},
				{
					code: "DEAD-001",
					cliPubkeyEd25519: cliPubkey,
					expiresAt: pastExpiry()
				}
			]);

			const alive = await app.db
				.select({ code: schema.tunnelPairing.code })
				.from(schema.tunnelPairing)
				.where(gt(schema.tunnelPairing.expiresAt, sql`now()`));

			expect(alive.map((r) => r.code)).toEqual(["ALIVE-001"]);
		});

		test("cycle pending → approved → consumed via UPDATE", async () => {
			const userId = await seedUser(app, "erin@example.com");

			await app.db.insert(schema.tunnelPairing).values({
				code: "CYCL-0001",
				cliPubkeyEd25519: cliPubkey,
				expiresAt: futureExpiry()
			});

			// Approve : renseigne user_id + approved_at + device_name.
			await app.db
				.update(schema.tunnelPairing)
				.set({
					userId,
					deviceName: "erin's MacBook",
					approvedAt: new Date()
				})
				.where(eq(schema.tunnelPairing.code, "CYCL-0001"));

			// Consume : renseigne consumed_at.
			await app.db
				.update(schema.tunnelPairing)
				.set({ consumedAt: new Date() })
				.where(eq(schema.tunnelPairing.code, "CYCL-0001"));

			const rows = await app.db
				.select()
				.from(schema.tunnelPairing)
				.where(eq(schema.tunnelPairing.code, "CYCL-0001"));
			expect(rows.length).toBe(1);
			// biome-ignore lint/style/noNonNullAssertion: length checked above
			expect(rows[0]!.userId).toBe(userId);
			// biome-ignore lint/style/noNonNullAssertion: length checked above
			expect(rows[0]!.deviceName).toBe("erin's MacBook");
			// biome-ignore lint/style/noNonNullAssertion: length checked above
			expect(rows[0]!.approvedAt).toBeInstanceOf(Date);
			// biome-ignore lint/style/noNonNullAssertion: length checked above
			expect(rows[0]!.consumedAt).toBeInstanceOf(Date);
		});

		test("index `pending & non-expired` — query composée filtrable", async () => {
			await app.db.insert(schema.tunnelPairing).values([
				{
					code: "PEND-001",
					cliPubkeyEd25519: cliPubkey,
					expiresAt: futureExpiry()
				},
				{
					code: "APPR-001",
					cliPubkeyEd25519: cliPubkey,
					expiresAt: futureExpiry(),
					approvedAt: new Date()
				}
			]);

			const pending = await app.db
				.select({ code: schema.tunnelPairing.code })
				.from(schema.tunnelPairing)
				.where(
					and(
						isNull(schema.tunnelPairing.approvedAt),
						gt(schema.tunnelPairing.expiresAt, sql`now()`)
					)
				);
			expect(pending.map((r) => r.code)).toEqual(["PEND-001"]);
		});

		test("DELETE user → CASCADE vide les pairings de ce user (approved)", async () => {
			const userId = await seedUser(app, "frank@example.com");
			await app.db.insert(schema.tunnelPairing).values({
				code: "FRNK-0001",
				userId,
				cliPubkeyEd25519: cliPubkey,
				approvedAt: new Date(),
				expiresAt: futureExpiry()
			});

			await app.db.delete(schema.user).where(eq(schema.user.id, userId));

			const rows = await app.db
				.select()
				.from(schema.tunnelPairing)
				.where(eq(schema.tunnelPairing.code, "FRNK-0001"));
			expect(rows.length).toBe(0);
		});
	});

	// ─── db_connection ────────────────────────────────────────────────
	describe("db_connection", () => {
		test("INSERT valide → row présente, engine_metadata default {}", async () => {
			const userId = await seedUser(app, "grace@example.com");
			await app.db.insert(schema.dbConnection).values({
				userId,
				name: "prod",
				cliFingerprint: "a".repeat(64),
				engine: "postgres"
			});

			const rows = await app.db
				.select()
				.from(schema.dbConnection)
				.where(eq(schema.dbConnection.userId, userId));
			expect(rows.length).toBe(1);
			const row = rows[0];
			// biome-ignore lint/style/noNonNullAssertion: length checked above
			expect(row!.name).toBe("prod");
			// biome-ignore lint/style/noNonNullAssertion: length checked above
			expect(row!.engine).toBe("postgres");
			// biome-ignore lint/style/noNonNullAssertion: length checked above
			expect(row!.engineMetadata).toEqual({});
			// biome-ignore lint/style/noNonNullAssertion: length checked above
			expect(row!.lastSeenAt).toBeNull();
			// biome-ignore lint/style/noNonNullAssertion: length checked above
			expect(row!.activeSince).toBeInstanceOf(Date);
		});

		test("unicité (user_id, name) — 2 `prod` pour même user → refus", async () => {
			const userId = await seedUser(app, "heidi@example.com");
			await app.db.insert(schema.dbConnection).values({
				userId,
				name: "prod",
				cliFingerprint: "a".repeat(64),
				engine: "postgres"
			});

			await expect(
				app.db.insert(schema.dbConnection).values({
					userId,
					name: "prod",
					cliFingerprint: "b".repeat(64),
					engine: "postgres"
				})
			).rejects.toThrow(/db_connection_user_name_unique|duplicate key/i);
		});

		test("2 users peuvent avoir chacun leur `prod`", async () => {
			const alice = await seedUser(app, "alice-conn@example.com");
			const bob = await seedUser(app, "bob-conn@example.com");
			await app.db.insert(schema.dbConnection).values([
				{
					userId: alice,
					name: "prod",
					cliFingerprint: "a".repeat(64),
					engine: "postgres"
				},
				{
					userId: bob,
					name: "prod",
					cliFingerprint: "b".repeat(64),
					engine: "postgres"
				}
			]);

			const total = await app.db
				.select({ count: sql<number>`count(*)::int` })
				.from(schema.dbConnection);
			// biome-ignore lint/style/noNonNullAssertion: aggregate always returns 1 row
			expect(total[0]!.count).toBe(2);
		});

		test("engine_metadata jsonb libre — accepte payload arbitraire", async () => {
			const userId = await seedUser(app, "ivan@example.com");
			const meta = {
				version: "16.2",
				schemas: ["public", "billing"],
				capabilities: { streaming: true }
			};
			await app.db.insert(schema.dbConnection).values({
				userId,
				name: "staging",
				cliFingerprint: "c".repeat(64),
				engine: "postgres",
				engineMetadata: meta
			});

			const rows = await app.db
				.select()
				.from(schema.dbConnection)
				.where(eq(schema.dbConnection.userId, userId));
			// biome-ignore lint/style/noNonNullAssertion: length checked above
			expect(rows[0]!.engineMetadata).toEqual(meta);
		});

		test("DELETE user → CASCADE vide les db_connection", async () => {
			const userId = await seedUser(app, "judy@example.com");
			await app.db.insert(schema.dbConnection).values({
				userId,
				name: "prod",
				cliFingerprint: "d".repeat(64),
				engine: "postgres"
			});

			await app.db.delete(schema.user).where(eq(schema.user.id, userId));

			const rows = await app.db
				.select()
				.from(schema.dbConnection)
				.where(eq(schema.dbConnection.userId, userId));
			expect(rows.length).toBe(0);
		});
	});
});
