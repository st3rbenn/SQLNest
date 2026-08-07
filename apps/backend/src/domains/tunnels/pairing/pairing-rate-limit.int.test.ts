/**
 * Test dédié — rate-limit sur `POST /api/tunnels/pairings`.
 *
 * ─── Pourquoi un fichier séparé ? ─────────────────────────────────────
 * `@fastify/rate-limit` stocke ses buckets in-memory (Map par key). Un
 * test qui envoie 11 req successives pollue le bucket pour le reste du
 * fichier. Isoler dans un fichier propre garantit une app fresh au
 * `beforeAll` (bucket vierge). Le `fileParallelism: false` du vitest
 * config évite qu'un autre fichier tape la même route en parallèle.
 *
 * ─── Portée ────────────────────────────────────────────────────────────
 * On teste UNIQUEMENT le comportement 11ème → 429 sur /pairings. Les
 * autres routes (status, approve, authenticate) sont vérifiées dans
 * `pairing.int.test.ts` — le mécanisme de rate-limit lui-même est le
 * plugin déjà unit-testé par `@fastify/rate-limit`, on ne re-vérifie
 * que le wiring de la config.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import rateLimit from "@fastify/rate-limit";
import { ed25519 } from "@noble/curves/ed25519.js";
import { config as loadEnv } from "dotenv";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import tunnelsRoute from "../../../routes/api/tunnels/root";
import { createTestApp, truncateTunnelsAndAuth } from "../../../utils/testapp";

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

describe.skipIf(!DATABASE_URL)(
	"/api/tunnels/pairings — rate limit (10/min/IP)",
	() => {
		let app: FastifyInstance;

		beforeAll(async () => {
			app = createTestApp({ withAuth: true });
			// `createTestApp` NE register PAS `01-rate-limit.plugin` (le plugin
			// global rate-limit du runtime). On l'enregistre ici manuellement
			// avec un `max` élevé (100) — les routes tunnels overridge la
			// config par route via `config.rateLimit` (10/min pour /pairings),
			// et ce override ne prend effet QUE si le plugin est présent.
			await app.register(rateLimit, {
				global: true,
				max: 100,
				timeWindow: "1 minute"
			});
			await app.register(tunnelsRoute, { prefix: "/api/tunnels" });
			await app.ready();
			await truncateTunnelsAndAuth(app);
		});

		afterAll(async () => {
			await app.close();
		});

		test("11ème requête consécutive → 429", async () => {
			const priv = ed25519.utils.randomSecretKey();
			const pub = ed25519.getPublicKey(priv);
			const pubkeyHex = Buffer.from(pub).toString("hex");

			// 10 premières requêtes doivent passer (max = 10, timeWindow = 1min).
			for (let i = 0; i < 10; i++) {
				const res = await app.inject({
					method: "POST",
					url: "/api/tunnels/pairings",
					headers: { "content-type": "application/json" },
					payload: { cliPubkeyEd25519: pubkeyHex }
				});
				expect(res.statusCode).toBe(200);
			}

			// 11ème → refus.
			const overflow = await app.inject({
				method: "POST",
				url: "/api/tunnels/pairings",
				headers: { "content-type": "application/json" },
				payload: { cliPubkeyEd25519: pubkeyHex }
			});
			expect(overflow.statusCode).toBe(429);
		});
	}
);
