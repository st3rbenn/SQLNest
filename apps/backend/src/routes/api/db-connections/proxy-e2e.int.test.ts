/**
 * Test E2E RÉEL — HTTP `/api/db-connections/:id/schema` → tunnel → CLI
 * réel qui touche Postgres (docker `sqlnest-postgres` / `sqlnest_shop`).
 *
 * ─── Ce que ça prouve ────────────────────────────────────────────────
 *   1. Backend HTTP reçoit la requête, résout la connection.
 *   2. Backend proxy signe + envoie la frame `req` (introspect) au CLI
 *      via le WS.
 *   3. Le CLI ws-client (prod code) reçoit, dispatch vers
 *      `introspectTunnel("shop")` de `@sqlnest/cli/engine`.
 *   4. `@sqlnest/engine` ouvre un pool Postgres réel sur `localhost:5433`
 *      (docker), introspecte le dataset e-commerce shop.
 *   5. Le résultat remonte : CLI → backend → HTTP response.
 *
 * Skip proprement si docker n'est pas disponible (CI sans postgres).
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import cookie from "@fastify/cookie";
import { ed25519 } from "@noble/curves/ed25519.js";
import {
	createTunnelWsClient,
	openConnectionForTunnel,
	type WsSocket
} from "@sqlnest/cli";
import { schema } from "@sqlnest/db";
import { runQuery } from "@sqlnest/engine";
import { config as loadEnv } from "dotenv";
import Fastify, { type FastifyInstance } from "fastify";
import {
	serializerCompiler,
	validatorCompiler
} from "fastify-type-provider-zod";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test
} from "vitest";
import WebSocket from "ws";
import { hashSha256Hex } from "../../../domains/tunnels/pairing/crypto";
import dbPlugin from "../../../plugins/02-db.plugin";
import authPlugin from "../../../plugins/03-auth.plugin";
import sessionPlugin from "../../../plugins/04-session.plugin";
import tunnelsPlugin from "../../../plugins/05-tunnels.plugin";
import backendIdentityPlugin from "../../../plugins/06-backend-identity.plugin";
import backendProxyPlugin from "../../../plugins/07-backend-proxy.plugin";
import {
	ensureTeamForUser,
	truncateTunnelsAndAuth
} from "../../../utils/testapp";
import tunnelsRoute from "../tunnels/root";
import tunnelsWsRoute from "../tunnels/ws";
import dbConnectionsProxyRoute from "./proxy";
import dbConnectionsRoute from "./root";

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
const SHOP_PG_URL =
	process.env.SQLNEST_TEST_PG_URL ??
	"postgres://sqlnest:sqlnest@localhost:5433/sqlnest_shop";

// ─── Probe docker (top-level await) — même pattern que engine.int.test.ts
const probeDir = mkdtempSync(join(tmpdir(), "sqlnest-proxy-e2e-probe-"));
process.env.SQLNEST_CONFIG_DIR = probeDir;
process.env.SQLNEST_PG_URL_SHOP = SHOP_PG_URL;
const dockerAvailable = await (async () => {
	try {
		const conn = await openConnectionForTunnel("shop");
		await conn.ping();
		await conn.close();
		return true;
	} catch {
		return false;
	}
})();
if (existsSync(probeDir)) rmSync(probeDir, { recursive: true, force: true });

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

async function seedConnectionAndSession(
	app: FastifyInstance,
	userId: string,
	cliPubHex: string
): Promise<{ connectionId: string; sessionId: string; token: string }> {
	const teamId = await ensureTeamForUser(app, userId);
	const conn = await app.db
		.insert(schema.dbConnection)
		.values({
			userId,
			teamId,
			name: "shop",
			cliFingerprint: hashSha256Hex(cliPubHex),
			engine: "postgres"
		})
		.returning({ id: schema.dbConnection.id });
	// biome-ignore lint/style/noNonNullAssertion: length
	const connectionId = conn[0]!.id;
	const token = `tn_${Buffer.from(
		crypto.getRandomValues(new Uint8Array(32))
	).toString("hex")}`;
	const sess = await app.db
		.insert(schema.tunnelSession)
		.values({
			connectionId,
			hash: hashSha256Hex(token),
			expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
		})
		.returning({ id: schema.tunnelSession.id });
	// biome-ignore lint/style/noNonNullAssertion: length
	return { connectionId, sessionId: sess[0]!.id, token };
}

/** Wrapper `ws` en `WsSocket` — pour le CLI ws-client. */
function wsFactory(url: string): WsSocket {
	const ws = new WebSocket(url);
	// biome-ignore lint/suspicious/noExplicitAny: cast overloads
	const on = (event: string, cb: (...args: any[]) => void): void => {
		if (event === "message") {
			ws.on("message", (data) => {
				const buf =
					data instanceof Buffer
						? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
						: new Uint8Array(0);
				const isolated = new Uint8Array(buf.length);
				isolated.set(buf);
				cb(isolated);
			});
		} else {
			// biome-ignore lint/suspicious/noExplicitAny: passthrough
			ws.on(event as any, cb as any);
		}
	};
	return {
		send: (b) => ws.send(b),
		close: (c, r) => ws.close(c, r),
		on: on as WsSocket["on"]
	};
}

async function buildApp(): Promise<{
	app: FastifyInstance;
	baseWsUrl: string;
	baseHttpUrl: string;
}> {
	const app = Fastify({ logger: false });
	app.setValidatorCompiler(validatorCompiler);
	app.setSerializerCompiler(serializerCompiler);
	await app.register(cookie);
	await app.register(dbPlugin);
	await app.register(authPlugin);
	await app.register(sessionPlugin);
	await app.register(tunnelsPlugin);
	await app.register(backendIdentityPlugin);
	await app.register(backendProxyPlugin);
	await app.register(dbConnectionsRoute, { prefix: "/api/db-connections" });
	// En prod l'autoload monte proxy.ts avec le même prefix ; en test on
	// register explicitement.
	await app.register(dbConnectionsProxyRoute, {
		prefix: "/api/db-connections"
	});
	// Route WSS `/api/tunnels/:sessionId/cli` — nécessaire pour que le
	// CLI ws-client puisse se connecter.
	await app.register(tunnelsRoute, { prefix: "/api/tunnels" });
	await app.register(tunnelsWsRoute, { prefix: "/api/tunnels" });
	await app.listen({ port: 0, host: "127.0.0.1" });
	const addr = app.server.address();
	if (typeof addr !== "object" || addr == null) throw new Error("no addr");
	return {
		app,
		baseWsUrl: `ws://127.0.0.1:${addr.port}`,
		baseHttpUrl: `http://127.0.0.1:${addr.port}`
	};
}

async function waitUntil(
	pred: () => boolean,
	timeoutMs: number
): Promise<void> {
	const start = Date.now();
	while (!pred()) {
		if (Date.now() - start > timeoutMs) {
			throw new Error(`waitUntil timeout après ${timeoutMs}ms`);
		}
		await new Promise((r) => setTimeout(r, 20));
	}
}

describe.skipIf(!DATABASE_URL || !dockerAvailable)(
	"E2E — HTTP → tunnel → CLI (Postgres shop réel)",
	() => {
		let app: FastifyInstance;
		let baseWsUrl: string;
		let baseHttpUrl: string;
		let tempCfg: string;

		beforeAll(async () => {
			const built = await buildApp();
			app = built.app;
			baseWsUrl = built.baseWsUrl;
			baseHttpUrl = built.baseHttpUrl;
		});

		afterAll(async () => {
			await app.close();
		});

		beforeEach(async () => {
			await truncateTunnelsAndAuth(app);
			tempCfg = mkdtempSync(join(tmpdir(), "sqlnest-proxy-e2e-"));
			process.env.SQLNEST_CONFIG_DIR = tempCfg;
			process.env.SQLNEST_PG_URL_SHOP = SHOP_PG_URL;
		});

		afterEach(() => {
			if (existsSync(tempCfg)) {
				rmSync(tempCfg, { recursive: true, force: true });
			}
		});

		test(
			"GET /api/db-connections/:id/schema → introspection Postgres shop réelle",
			{ timeout: 15_000 },
			async () => {
				const { cookie, userId } = await createTestUser(
					app,
					"proxy-e2e@example.com",
					"correct-horse-battery-staple"
				);

				const cliPriv = ed25519.utils.randomSecretKey();
				const cliPub = ed25519.getPublicKey(cliPriv);
				const cliPubHex = Buffer.from(cliPub).toString("hex");

				const { connectionId, sessionId, token } =
					await seedConnectionAndSession(app, userId, cliPubHex);

				// CLI ws-client réel — runOp branché sur `@sqlnest/engine`
				// via le wrapper `openConnectionForTunnel("shop")`.
				const cli = createTunnelWsClient({
					baseWsUrl,
					sessionId,
					token,
					cliEd25519Private: cliPriv,
					cliEd25519Public: cliPub,
					async runOp(op) {
						if (op.op === "introspect") {
							const conn = await openConnectionForTunnel("shop");
							try {
								const s = await conn.introspect();
								return { ok: true, data: s };
							} finally {
								await conn.close();
							}
						}
						if (op.op === "runSnql") {
							const conn = await openConnectionForTunnel("shop");
							try {
								const rs = await runQuery(conn, op.src);
								return {
									ok: true,
									data: {
										columns: rs.columns,
										rows: rs.rows,
										rowCount: rs.rowCount,
										written: rs.written
									}
								};
							} finally {
								await conn.close();
							}
						}
						return {
							ok: false,
							error: `op inconnue: ${(op as { op: string }).op}`
						};
					},
					socketFactory: wsFactory,
					reconnectInitialMs: 100
				});
				cli.start();
				await waitUntil(() => cli.isConnected(), 3000);
				// Attend que le registry côté serveur reflète l'attach CLI
				// (isConnected côté client est set à sock.on("open") — le
				// serveur handler termine juste après avec attachCli).
				await waitUntil(
					() => app.tunnelRegistry.getSlot(sessionId)?.cli != null,
					2000
				);

				// Appel HTTP côté backend → attend response.
				const res = await fetch(
					`${baseHttpUrl}/api/db-connections/${connectionId}/schema`,
					{ headers: { cookie } }
				);
				expect(res.status).toBe(200);
				const body = (await res.json()) as {
					engine: string;
					collections: Array<{ name: string }>;
				};
				expect(body.engine).toBe("postgres");
				const names = new Set(body.collections.map((c) => c.name));
				// Le seed shop crée au minimum `users`, `orders`, `products`.
				expect(names.has("users")).toBe(true);
				expect(names.has("orders")).toBe(true);
				expect(names.has("products")).toBe(true);

				await cli.stop();
				await new Promise((r) => setTimeout(r, 100));
			}
		);

		test(
			"POST /api/db-connections/:id/query → SNQL réel côté shop",
			{ timeout: 15_000 },
			async () => {
				const { cookie, userId } = await createTestUser(
					app,
					"proxy-e2e-query@example.com",
					"long-and-strong-password-12"
				);
				const cliPriv = ed25519.utils.randomSecretKey();
				const cliPub = ed25519.getPublicKey(cliPriv);
				const cliPubHex = Buffer.from(cliPub).toString("hex");
				const { connectionId, sessionId, token } =
					await seedConnectionAndSession(app, userId, cliPubHex);

				const cli = createTunnelWsClient({
					baseWsUrl,
					sessionId,
					token,
					cliEd25519Private: cliPriv,
					cliEd25519Public: cliPub,
					async runOp(op) {
						if (op.op === "runSnql") {
							const conn = await openConnectionForTunnel("shop");
							try {
								const rs = await runQuery(conn, op.src);
								return {
									ok: true,
									data: {
										columns: rs.columns,
										rows: rs.rows,
										rowCount: rs.rowCount,
										written: rs.written
									}
								};
							} finally {
								await conn.close();
							}
						}
						return { ok: false, error: `op unhandled` };
					},
					socketFactory: wsFactory,
					reconnectInitialMs: 100
				});
				cli.start();
				await waitUntil(() => cli.isConnected(), 3000);
				// Attend que le registry côté serveur reflète l'attach CLI
				// (isConnected côté client est set à sock.on("open") — le
				// serveur handler termine juste après avec attachCli).
				await waitUntil(
					() => app.tunnelRegistry.getSlot(sessionId)?.cli != null,
					2000
				);

				const res = await fetch(
					`${baseHttpUrl}/api/db-connections/${connectionId}/query`,
					{
						method: "POST",
						headers: { cookie, "content-type": "application/json" },
						body: JSON.stringify({ source: "get users | pick id | limit 3" })
					}
				);
				expect(res.status).toBe(200);
				const body = (await res.json()) as {
					rows: Array<Record<string, unknown>>;
					rowCount: number;
					written: boolean;
				};
				expect(body.written).toBe(false);
				expect(body.rows.length).toBeGreaterThan(0);
				expect(body.rows.length).toBeLessThanOrEqual(3);

				await cli.stop();
				await new Promise((r) => setTimeout(r, 100));
			}
		);
	}
);
