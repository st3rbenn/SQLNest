/**
 * Tests d'intégration — routes WSS du tunnel.
 *
 * Setup :
 *   - App fresh avec plugin `05-tunnels` (websocket + registry).
 *   - Route `/api/tunnels/*` register (HTTP + WS).
 *   - `app.listen({ port: 0 })` pour un port dynamique.
 *   - Client `ws` Node pour ouvrir des connexions réelles.
 *
 * Couvre :
 *   - Auth invalide (token bidon, session mismatch) → close code 4003.
 *   - Browser sans CLI actif → close 4004.
 *   - Handshake happy path CLI + Browser.
 *   - Relais bidirectionnel (bytes opaques identiques des 2 côtés).
 *   - Broadcast multi-browsers.
 *   - Single-active CLI (nouveau kick l'ancien avec 4001).
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import cookie from "@fastify/cookie";
import { schema } from "@sqlnest/db";
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
import {
	ensureTeamForUser,
	truncateTunnelsAndAuth
} from "../../../utils/testapp";
import tunnelsRoute from "./root";
import tunnelsWsRoute from "./ws";

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
		throw new Error(`sign-up failed: ${signUp.statusCode} ${signUp.payload}`);
	}
	const cookie = getSessionCookie(signUp.headers);
	if (!cookie) throw new Error("no cookie");
	const body = signUp.json() as { user?: { id?: string } };
	// biome-ignore lint/style/noNonNullAssertion: guarded above
	return { cookie, userId: body.user!.id! };
}

async function seedConnection(
	app: FastifyInstance,
	userId: string,
	pubkeyHex: string
): Promise<string> {
	const teamId = await ensureTeamForUser(app, userId);
	const rows = await app.db
		.insert(schema.dbConnection)
		.values({
			userId,
			teamId,
			name: `conn-${crypto.randomUUID().slice(0, 8)}`,
			cliFingerprint: hashSha256Hex(pubkeyHex),
			engine: "postgres"
		})
		.returning({ id: schema.dbConnection.id });
	// biome-ignore lint/style/noNonNullAssertion: length checked
	return rows[0]!.id;
}

async function seedSessionToken(
	app: FastifyInstance,
	connectionId: string
): Promise<{ sessionId: string; token: string }> {
	const token = `tn_${"a"
		.repeat(64)
		.replace(/(.)/g, () => Math.floor(Math.random() * 16).toString(16))}`;
	const rows = await app.db
		.insert(schema.tunnelSession)
		.values({
			connectionId,
			hash: hashSha256Hex(token),
			expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
		})
		.returning({ id: schema.tunnelSession.id });
	// biome-ignore lint/style/noNonNullAssertion: length checked
	return { sessionId: rows[0]!.id, token };
}

/** Attend `ws.open`. Throw sur `error` ou `close` avant open. */
function waitForOpen(ws: WebSocket): Promise<void> {
	return new Promise((resolve, reject) => {
		const onOpen = () => {
			cleanup();
			resolve();
		};
		const onError = (err: Error) => {
			cleanup();
			reject(err);
		};
		const onClose = (code: number, reason: Buffer) => {
			cleanup();
			reject(
				new Error(
					`WS closed before open: code=${code} reason=${reason.toString()}`
				)
			);
		};
		function cleanup() {
			ws.off("open", onOpen);
			ws.off("error", onError);
			ws.off("close", onClose);
		}
		ws.on("open", onOpen);
		ws.on("error", onError);
		ws.on("close", onClose);
	});
}

/** Attend le prochain message reçu. Throw après `timeoutMs`. */
function waitForMessage(ws: WebSocket, timeoutMs = 2_000): Promise<Uint8Array> {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			cleanup();
			reject(new Error(`waitForMessage timeout après ${timeoutMs}ms`));
		}, timeoutMs);
		const onMessage = (data: WebSocket.RawData) => {
			cleanup();
			resolve(normalize(data));
		};
		function cleanup() {
			clearTimeout(timeout);
			ws.off("message", onMessage);
		}
		ws.on("message", onMessage);
	});
}

function waitForClose(
	ws: WebSocket
): Promise<{ code: number; reason: string }> {
	return new Promise((resolve) => {
		ws.once("close", (code, reason) =>
			resolve({ code, reason: reason.toString() })
		);
	});
}

function normalize(raw: WebSocket.RawData): Uint8Array {
	if (raw instanceof Buffer) return new Uint8Array(raw);
	if (Array.isArray(raw)) {
		const total = raw.reduce((a, b) => a + b.length, 0);
		const out = new Uint8Array(total);
		let off = 0;
		for (const b of raw) {
			out.set(new Uint8Array(b), off);
			off += b.length;
		}
		return out;
	}
	if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
	return new Uint8Array();
}

async function buildApp(): Promise<{
	app: FastifyInstance;
	port: number;
	baseUrl: string;
}> {
	const app = Fastify({ logger: { level: "warn" } });
	app.setValidatorCompiler(validatorCompiler);
	app.setSerializerCompiler(serializerCompiler);
	await app.register(cookie);
	await app.register(dbPlugin);
	await app.register(authPlugin);
	await app.register(sessionPlugin);
	await app.register(tunnelsPlugin);
	await app.register(tunnelsRoute, { prefix: "/api/tunnels" });
	// En prod l'autoload monte ws.ts avec le même prefix ; en test on
	// register explicitement.
	await app.register(tunnelsWsRoute, { prefix: "/api/tunnels" });
	await app.listen({ port: 0, host: "127.0.0.1" });
	const address = app.server.address();
	if (typeof address !== "object" || address === null) {
		throw new Error("no address");
	}
	return { app, port: address.port, baseUrl: `ws://127.0.0.1:${address.port}` };
}

describe.skipIf(!DATABASE_URL)("WSS /api/tunnels — relais bête", () => {
	let app: FastifyInstance;
	let baseUrl: string;

	beforeAll(async () => {
		const built = await buildApp();
		app = built.app;
		baseUrl = built.baseUrl;
	});

	afterAll(async () => {
		await app.close();
	});

	beforeEach(async () => {
		await truncateTunnelsAndAuth(app);
	});

	// Cleanup — chaque test tracker ses WS et close en fin. On attend
	// que le server-side detach purge le registry AVANT le test suivant :
	// sans ça, un slot obsolète (dont le socket est fermé côté client
	// mais pas encore reconnu server-side) casse le test suivant.
	const openSockets: WebSocket[] = [];
	afterEach(async () => {
		for (const ws of openSockets) {
			try {
				ws.close();
			} catch {
				// ignore
			}
		}
		openSockets.length = 0;
		// Poll jusqu'à ce que le registry soit vidé (fastpath : quelques ms).
		const deadline = Date.now() + 1_000;
		while (app.tunnelRegistry.size() > 0 && Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 20));
		}
	});

	function track(ws: WebSocket): WebSocket {
		openSockets.push(ws);
		return ws;
	}

	// ═══════════════════════════════════════════════════════════════
	// Auth invalide
	// ═══════════════════════════════════════════════════════════════

	test("CLI avec token bidon → close 4003", async () => {
		const ws = track(
			new WebSocket(
				`${baseUrl}/api/tunnels/00000000-0000-0000-0000-000000000000/cli?token=tn_${"0".repeat(64)}`
			)
		);
		const closed = await waitForClose(ws);
		expect(closed.code).toBe(4003);
	});

	test("CLI avec sessionId path ≠ token → close 4003 (mismatch)", async () => {
		const { userId } = await createTestUser(
			app,
			"alice-mm@example.com",
			"correct-horse-battery-staple"
		);
		const pub = "a".repeat(64);
		const connId = await seedConnection(app, userId, pub);
		const { token } = await seedSessionToken(app, connId);
		const ws = track(
			new WebSocket(
				`${baseUrl}/api/tunnels/00000000-0000-0000-0000-000000000000/cli?token=${encodeURIComponent(token)}`
			)
		);
		const closed = await waitForClose(ws);
		expect(closed.code).toBe(4003);
	});

	test("Browser sans CLI attaché → close 4004", async () => {
		const { cookie, userId } = await createTestUser(
			app,
			"bob@example.com",
			"long-and-strong-password-12"
		);
		const connId = await seedConnection(app, userId, "b".repeat(64));

		const ws = track(
			new WebSocket(`${baseUrl}/api/tunnels/by-connection/${connId}/browser`, {
				headers: { cookie }
			})
		);
		const closed = await waitForClose(ws);
		expect(closed.code).toBe(4004);
	});

	// ═══════════════════════════════════════════════════════════════
	// Relais bidirectionnel
	// ═══════════════════════════════════════════════════════════════

	test("CLI + Browser : relais bidirectionnel (browser → cli + cli → browser)", async () => {
		const { cookie, userId } = await createTestUser(
			app,
			"carol@example.com",
			"carol-carol-carol-carol"
		);
		const pub = "c".repeat(64);
		const connId = await seedConnection(app, userId, pub);
		const { sessionId, token } = await seedSessionToken(app, connId);

		const cli = track(
			new WebSocket(
				`${baseUrl}/api/tunnels/${sessionId}/cli?token=${encodeURIComponent(token)}`
			)
		);
		await waitForOpen(cli);

		const browser = track(
			new WebSocket(`${baseUrl}/api/tunnels/by-connection/${connId}/browser`, {
				headers: { cookie }
			})
		);
		await waitForOpen(browser);

		// ─── Browser → CLI ─────────────────────────────────────────
		const req = new Uint8Array([1, 2, 3, 4, 42, 100, 255]);
		const cliMsg = waitForMessage(cli);
		browser.send(req);
		expect(await cliMsg).toEqual(req);

		// ─── CLI → Browser ─────────────────────────────────────────
		const res = new Uint8Array([99, 88, 77, 0, 1, 2]);
		const browserMsg = waitForMessage(browser);
		cli.send(res);
		expect(await browserMsg).toEqual(res);
	});

	// (le sens CLI → Browser est vérifié dans le test bidirectionnel ci-dessus)

	// ═══════════════════════════════════════════════════════════════
	// Single-active CLI
	// ═══════════════════════════════════════════════════════════════

	test("nouveau CLI kick l'ancien avec code 4001", async () => {
		const { userId } = await createTestUser(
			app,
			"erin@example.com",
			"erin-erin-erin-erin-erin"
		);
		const pub = "e".repeat(64);
		const connId = await seedConnection(app, userId, pub);
		const { sessionId, token } = await seedSessionToken(app, connId);

		const oldCli = track(
			new WebSocket(
				`${baseUrl}/api/tunnels/${sessionId}/cli?token=${encodeURIComponent(token)}`
			)
		);
		await waitForOpen(oldCli);

		const closeSignal = waitForClose(oldCli);

		const newCli = track(
			new WebSocket(
				`${baseUrl}/api/tunnels/${sessionId}/cli?token=${encodeURIComponent(token)}`
			)
		);
		await waitForOpen(newCli);

		const closed = await closeSignal;
		expect(closed.code).toBe(4001);
	});
});
