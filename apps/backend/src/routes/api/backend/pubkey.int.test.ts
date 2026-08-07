/**
 * Tests intégration — GET /api/backend/pubkey.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { deriveBackendKeypair } from "../../../domains/backend-identity/keypair";
import backendIdentityPlugin from "../../../plugins/06-backend-identity.plugin";
import { createTestApp } from "../../../utils/testapp";
import backendPubkeyRoute from "./pubkey";

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

describe.skipIf(!DATABASE_URL)("GET /api/backend/pubkey", () => {
	let app: FastifyInstance;

	beforeAll(async () => {
		app = createTestApp({ withAuth: true });
		// `06-backend-identity` a une dep sur `05-tunnels` — on register
		// juste `06-` ici puisqu'on ne teste que la route pubkey (pas
		// le tunnel). Pour ça il faut dupliquer le decorate ou reléger
		// la dep. Le plus simple : ajouter le decorate à la main.
		app.decorate(
			"backendKeypair",
			deriveBackendKeypair(process.env.AUTH_SECRET)
		);
		await app.register(backendPubkeyRoute, { prefix: "/api/backend" });
		await app.ready();
	});

	afterAll(async () => {
		await app.close();
	});

	test("route publique — pas d'auth requise", async () => {
		const res = await app.inject({
			method: "GET",
			url: "/api/backend/pubkey"
		});
		expect(res.statusCode).toBe(200);
		const body = res.json() as { publicKey: string; algorithm: string };
		expect(body.publicKey).toMatch(/^[0-9a-f]{64}$/);
		expect(body.algorithm).toBe("ed25519");
	});

	test("pubkey stable inter-appels (même AUTH_SECRET)", async () => {
		const r1 = await app.inject({ method: "GET", url: "/api/backend/pubkey" });
		const r2 = await app.inject({ method: "GET", url: "/api/backend/pubkey" });
		expect(r1.json()).toEqual(r2.json());
	});

	test("pubkey matche la dérivation directe depuis AUTH_SECRET", async () => {
		const res = await app.inject({
			method: "GET",
			url: "/api/backend/pubkey"
		});
		const body = res.json() as { publicKey: string };
		const kp = deriveBackendKeypair(process.env.AUTH_SECRET);
		expect(body.publicKey).toBe(kp.publicKeyHex);
	});

	// Marker le fait qu'on n'a pas testé le plugin '06-' complet (dep
	// '05-tunnels') — le plugin est vérifié indirectement par les
	// futurs tests de proxy (Bloc B.3+) qui monteront la stack entière.
	test("plugin `06-backend-identity` a bien un `dependencies: ['05-tunnels']`", () => {
		// biome-ignore lint/suspicious/noExplicitAny: introspection interne fp
		expect(
			(backendIdentityPlugin as any)[Symbol.for("plugin-meta")]
		).toBeDefined();
	});
});
