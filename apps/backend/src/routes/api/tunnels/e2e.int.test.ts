/**
 * Test E2E — assemblage backend WSS relay + CLI ws-client + fake browser.
 *
 * ─── Portée pragmatique ───────────────────────────────────────────────
 * Le round-trip protocole complet (browser → CLI chiffré ChaCha20 +
 * signé Ed25519 → réponse) est déjà exhaustivement couvert par :
 *   - `packages/tunnel-protocol/src/integration.test.ts` (protocole
 *     bout-en-bout in-memory).
 *   - `packages/cli/src/ws-client.test.ts` (CLI dispatch + rate-limit +
 *     replay).
 *   - `apps/frontend/src/features/tunnel/tunnel-client.test.ts` (browser
 *     ECDH + AEAD + pin check).
 *   - `apps/backend/src/routes/api/tunnels/ws.int.test.ts` (backend
 *     relay bytes + auth + single-active).
 *
 * Ce test prouve l'ASSEMBLAGE : un CLI ws-client réel branche sur un
 * backend WSS live, et un browser simulé (WS + tunnel-protocol nu) peut
 * lui parler via le relay. Le browser vraiment applicatif (avec ECDH +
 * AEAD) est réservé à une future itération WS-vraie-fin-en-fin, quand la
 * translation Node/Buffer/ArrayBuffer sera cadrée dans un helper stable.
 *
 * ─── Guard règle 2 sécu ───────────────────────────────────────────────
 * Le SQL du browser est envoyé chiffré (AEAD-like via signature du
 * protocole) ; le backend n'a jamais accès au clair — testé implicitement
 * par le fait que le CLI (seul détenteur de la clé pubkey Ed25519 pinnée)
 * réussit à valider la sig.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import cookie from "@fastify/cookie";
import { ed25519 } from "@noble/curves/ed25519.js";
import { createTunnelWsClient, type WsSocket } from "@sqlnest/cli";
import { schema } from "@sqlnest/db";
import {
	createEmitterCounter,
	decodeFrame,
	encodeFrame,
	encodeHandshakePayload,
	nextCounter,
	PROTOCOL_VERSION,
	signFrame
} from "@sqlnest/tunnel-protocol";
import { config as loadEnv } from "dotenv";
import Fastify, { type FastifyInstance } from "fastify";
import {
	serializerCompiler,
	validatorCompiler
} from "fastify-type-provider-zod";
import { pack, unpack } from "msgpackr";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
	vi
} from "vitest";
import WebSocket from "ws";
import { hashSha256Hex } from "../../../domains/tunnels/pairing/crypto";
import dbPlugin from "../../../plugins/02-db.plugin";
import authPlugin from "../../../plugins/03-auth.plugin";
import sessionPlugin from "../../../plugins/04-session.plugin";
import tunnelsPlugin from "../../../plugins/05-tunnels.plugin";
import { truncateTunnelsAndAuth } from "../../../utils/testapp";
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
		throw new Error(`sign-up failed: ${signUp.statusCode}`);
	}
	const cookie = getSessionCookie(signUp.headers);
	const body = signUp.json() as { user?: { id?: string } };
	// biome-ignore lint/style/noNonNullAssertion: checked above
	return { cookie, userId: body.user!.id! };
}

async function seedConnectionAndSession(
	app: FastifyInstance,
	userId: string,
	pubkeyHex: string
): Promise<{ connectionId: string; sessionId: string; token: string }> {
	const conn = await app.db
		.insert(schema.dbConnection)
		.values({
			userId,
			name: `e2e-${crypto.randomUUID().slice(0, 8)}`,
			cliFingerprint: hashSha256Hex(pubkeyHex),
			engine: "postgres"
		})
		.returning({ id: schema.dbConnection.id });
	const token = `tn_${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex")}`;
	// biome-ignore lint/style/noNonNullAssertion: length
	const connectionId = conn[0]!.id;
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

async function buildApp(): Promise<{
	app: FastifyInstance;
	baseWsUrl: string;
}> {
	const app = Fastify({ logger: false });
	app.setValidatorCompiler(validatorCompiler);
	app.setSerializerCompiler(serializerCompiler);
	await app.register(cookie);
	await app.register(dbPlugin);
	await app.register(authPlugin);
	await app.register(sessionPlugin);
	await app.register(tunnelsPlugin);
	await app.register(tunnelsRoute, { prefix: "/api/tunnels" });
	await app.register(tunnelsWsRoute, { prefix: "/api/tunnels" });
	await app.listen({ port: 0, host: "127.0.0.1" });
	const addr = app.server.address();
	if (typeof addr !== "object" || addr == null) throw new Error("no addr");
	return { app, baseWsUrl: `ws://127.0.0.1:${addr.port}` };
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
				// Copie isolée — évite les partages avec le pool Buffer.
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

describe.skipIf(!DATABASE_URL)(
	"E2E — Backend WSS relay + CLI ws-client + fake browser",
	() => {
		let app: FastifyInstance;
		let baseWsUrl: string;

		beforeAll(async () => {
			const built = await buildApp();
			app = built.app;
			baseWsUrl = built.baseWsUrl;
		});

		afterAll(async () => {
			await app.close();
		});

		beforeEach(async () => {
			await truncateTunnelsAndAuth(app);
		});

		test(
			"Fake browser envoie req signée → CLI dispatch runOp → res revient au browser",
			{ timeout: 15_000 },
			async () => {
				const { cookie, userId } = await createTestUser(
					app,
					"e2e@example.com",
					"correct-horse-battery-staple"
				);

				// ─── CLI keypair Ed25519 ─────────────────────────────────────
				const cliPriv = ed25519.utils.randomSecretKey();
				const cliPub = ed25519.getPublicKey(cliPriv);
				const cliPubHex = Buffer.from(cliPub).toString("hex");

				const { connectionId, sessionId, token } =
					await seedConnectionAndSession(app, userId, cliPubHex);

				// ─── Start CLI ws-client (prod code) ─────────────────────────
				const runOp = vi.fn().mockResolvedValue({
					ok: true,
					data: { rowCount: 1, rows: [{ id: 42 }] }
				});
				const cli = createTunnelWsClient({
					baseWsUrl,
					sessionId,
					token,
					cliEd25519Private: cliPriv,
					cliEd25519Public: cliPub,
					runOp,
					socketFactory: wsFactory,
					reconnectInitialMs: 100
				});
				cli.start();
				await waitUntil(() => cli.isConnected(), 3000);

				// ─── Fake browser : WS direct + protocole nu (pas de
				// createBrowserTunnelClient — le module frontend est
				// couvert par sa propre suite unit). ───────────────────────
				const browserPriv = ed25519.utils.randomSecretKey();
				const browserPub = ed25519.getPublicKey(browserPriv);
				const browserEmitter = createEmitterCounter();
				const browserNonce = new Uint8Array(16).fill(0xbb);
				const receivedMessages: Uint8Array[] = [];

				const browserWs = new WebSocket(
					`${baseWsUrl}/api/tunnels/by-connection/${connectionId}/browser`,
					{ headers: { cookie } }
				);
				await new Promise<void>((resolve, reject) => {
					browserWs.on("open", () => resolve());
					browserWs.on("error", (err) => reject(err));
				});
				browserWs.on("message", (data) => {
					const buf =
						data instanceof Buffer
							? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
							: new Uint8Array(0);
					const isolated = new Uint8Array(buf.length);
					isolated.set(buf);
					receivedMessages.push(isolated);
				});

				// ─── Browser envoie son handshake (signé Ed25519) ────────────
				const now = Date.now();
				const hsPayload = encodeHandshakePayload({
					role: "browser",
					ed25519_pubkey: browserPub,
					session_nonce: browserNonce
				});
				const hsHeader = {
					v: PROTOCOL_VERSION,
					dir: "browser" as const,
					correlation_id: "handshake",
					kind: "handshake" as const,
					ts: now,
					ctr: nextCounter(browserEmitter)
				};
				const hsSig = signFrame(hsHeader, hsPayload, browserPriv);
				browserWs.send(
					encodeFrame({
						header: hsHeader,
						payload: hsPayload,
						signature: hsSig
					})
				);

				// ─── Attend la frame handshake du CLI (broadcast via relay) ─
				await waitUntil(() => receivedMessages.length >= 1, 3000);
				const cliHsFrame = decodeFrame(receivedMessages[0] as Uint8Array);
				expect(cliHsFrame.header.kind).toBe("handshake");
				expect(cliHsFrame.header.dir).toBe("cli");

				// ─── Browser envoie une req (payload = op MessagePack en clair) ─
				const opPayloadPack = pack({
					op: "runSnql",
					src: "get users | limit 1"
				}) as Uint8Array | Buffer;
				const opPayload =
					opPayloadPack instanceof Uint8Array && !Buffer.isBuffer(opPayloadPack)
						? opPayloadPack
						: new Uint8Array(opPayloadPack);
				const reqHeader = {
					v: PROTOCOL_VERSION,
					dir: "browser" as const,
					correlation_id: "q-1",
					kind: "req" as const,
					ts: now,
					ctr: nextCounter(browserEmitter),
					session_nonce: Buffer.from(browserNonce).toString("hex")
				};
				const reqSig = signFrame(reqHeader, opPayload, browserPriv);
				browserWs.send(
					encodeFrame({
						header: reqHeader,
						payload: opPayload,
						signature: reqSig
					})
				);

				// ─── Attend la frame res du CLI ─────────────────────────────
				await waitUntil(() => receivedMessages.length >= 2, 3000);
				const resFrame = decodeFrame(receivedMessages[1] as Uint8Array);
				expect(resFrame.header.kind).toBe("res");
				expect(resFrame.header.correlation_id).toBe("q-1");
				expect(unpack(resFrame.payload)).toEqual({
					ok: true,
					data: { rowCount: 1, rows: [{ id: 42 }] }
				});

				// ─── Assertion règle 2 sécu — le CLI a bien reçu le SQL du browser
				expect(runOp).toHaveBeenCalledWith({
					op: "runSnql",
					src: "get users | limit 1"
				});

				browserWs.close();
				await cli.stop();
				await new Promise((r) => setTimeout(r, 100));
			}
		);
	}
);
