/**
 * Tests intégration — routes proxifiées
 * `GET /api/db-connections/:id/schema` et `POST /:id/query`.
 *
 * Setup :
 *   - App fresh avec plugins 02→07 (auth + tunnels registry + backend
 *     identity + backend proxy).
 *   - Route `/api/db-connections` register (list + proxy).
 *   - Un "fake CLI" attaché au registry via un RegistrySocket in-process :
 *     capture les frames backend → decode → répond avec res signée par
 *     la keypair CLI.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import cookie from "@fastify/cookie";
import { ed25519 } from "@noble/curves/ed25519.js";
import { schema } from "@sqlnest/db";
import {
	createEmitterCounter,
	decodeFrame,
	encodeFrame,
	encodeHandshakePayload,
	generateSessionNonce,
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
import { pack } from "msgpackr";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test
} from "vitest";
import { hashSha256Hex } from "../../../domains/tunnels/pairing/crypto";
import type { RegistrySocket } from "../../../domains/tunnels/session/registry";
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
	pubkeyHex: string
): Promise<{ connectionId: string; sessionId: string }> {
	const teamId = await ensureTeamForUser(app, userId);
	const conn = await app.db
		.insert(schema.dbConnection)
		.values({
			userId,
			teamId,
			name: `proxy-${crypto.randomUUID().slice(0, 8)}`,
			cliFingerprint: hashSha256Hex(pubkeyHex),
			engine: "postgres"
		})
		.returning({ id: schema.dbConnection.id });
	// biome-ignore lint/style/noNonNullAssertion: length
	const connectionId = conn[0]!.id;
	const sess = await app.db
		.insert(schema.tunnelSession)
		.values({
			connectionId,
			hash: hashSha256Hex(`sess-${connectionId}`),
			expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
		})
		.returning({ id: schema.tunnelSession.id });
	// biome-ignore lint/style/noNonNullAssertion: length
	return { connectionId, sessionId: sess[0]!.id };
}

/** Fake CLI attaché au registry — capture les bytes envoyés par le
 *  backend, expose une méthode pour répondre par une frame res signée. */
function attachFakeCli(
	app: FastifyInstance,
	tunnelId: string,
	userId: string,
	connectionId: string,
	cliPub: Uint8Array
): {
	sentToCli: Uint8Array[];
	replyRes: (correlationId: string, data: unknown) => void;
	replyHandshake: () => void;
	priv: Uint8Array;
	pub: Uint8Array;
} {
	const priv = ed25519.utils.randomSecretKey();
	// biome-ignore lint/correctness/noUnusedVariables: kept for symmetry, actual pub is cliPub
	const _pub = ed25519.getPublicKey(priv);
	// On utilise la pubkey passée pour matcher `cliFingerprint`
	const emitter = createEmitterCounter();
	const nonce = generateSessionNonce();
	const sentToCli: Uint8Array[] = [];

	const cliSock: RegistrySocket = {
		id: "fake-cli",
		send: (bytes) => sentToCli.push(bytes),
		close: () => undefined
	};
	app.tunnelRegistry.attachCli({
		tunnelId,
		userId,
		connectionId,
		cliFingerprint: hashSha256Hex(bytesToHex(cliPub)),
		socket: cliSock
	});

	function replyHandshake(): void {
		const payload = encodeHandshakePayload({
			role: "cli",
			ed25519_pubkey: cliPub,
			session_nonce: nonce
		});
		const header = {
			v: PROTOCOL_VERSION,
			dir: "cli" as const,
			correlation_id: "handshake",
			kind: "handshake" as const,
			ts: Date.now(),
			ctr: nextCounter(emitter)
		};
		const sig = signFrame(header, payload, priv);
		app.tunnelRegistry.routeToBrowsersFromCli(
			tunnelId,
			encodeFrame({ header, payload, signature: sig })
		);
	}

	function replyRes(correlationId: string, data: unknown): void {
		const p = pack({ ok: true, data }) as Uint8Array | Buffer;
		const payload =
			p instanceof Uint8Array && !Buffer.isBuffer(p) ? p : new Uint8Array(p);
		const header = {
			v: PROTOCOL_VERSION,
			dir: "cli" as const,
			correlation_id: correlationId,
			kind: "res" as const,
			ts: Date.now(),
			ctr: nextCounter(emitter),
			session_nonce: Buffer.from(new Uint8Array(16)).toString("hex")
		};
		const sig = signFrame(header, payload, priv);
		app.tunnelRegistry.routeToBrowsersFromCli(
			tunnelId,
			encodeFrame({ header, payload, signature: sig })
		);
	}

	return {
		sentToCli,
		replyRes,
		replyHandshake,
		priv,
		pub: cliPub
	};
}

function bytesToHex(bytes: Uint8Array): string {
	let s = "";
	for (const b of bytes) s += b.toString(16).padStart(2, "0");
	return s;
}

async function buildApp(): Promise<FastifyInstance> {
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
	// register explicitement (createTestApp n'a pas d'autoload).
	await app.register(dbConnectionsProxyRoute, {
		prefix: "/api/db-connections"
	});
	await app.ready();
	return app;
}

describe.skipIf(!DATABASE_URL)(
	"/api/db-connections/:id/{schema,query} — proxy vers CLI",
	() => {
		let app: FastifyInstance;

		beforeAll(async () => {
			app = await buildApp();
		});

		afterAll(async () => {
			await app.close();
		});

		beforeEach(async () => {
			await truncateTunnelsAndAuth(app);
		});

		test("sans cookie → 401", async () => {
			const id = crypto.randomUUID();
			const res = await app.inject({
				method: "GET",
				url: `/api/db-connections/${id}/schema`
			});
			expect(res.statusCode).toBe(401);
		});

		test("connection inconnue → 404", async () => {
			const { cookie } = await createTestUser(
				app,
				"alice@example.com",
				"correct-horse-battery-staple"
			);
			const res = await app.inject({
				method: "GET",
				url: `/api/db-connections/${crypto.randomUUID()}/schema`,
				headers: { cookie }
			});
			expect(res.statusCode).toBe(404);
		});

		test("cross-user leak — Alice tente d'accéder à la connection de Bob → 404", async () => {
			const alice = await createTestUser(
				app,
				"alice-x@example.com",
				"alice-alice-alice-alice"
			);
			const bob = await createTestUser(
				app,
				"bob-x@example.com",
				"bob-bob-bob-bob-bob-bob"
			);
			const { connectionId } = await seedConnectionAndSession(
				app,
				bob.userId,
				"a".repeat(64)
			);
			const res = await app.inject({
				method: "GET",
				url: `/api/db-connections/${connectionId}/schema`,
				headers: { cookie: alice.cookie }
			});
			expect(res.statusCode).toBe(404);
		});

		test("pas de tunnel actif → 503 avec message CLI", async () => {
			const { cookie, userId } = await createTestUser(
				app,
				"carol@example.com",
				"carol-carol-carol-carol"
			);
			const { connectionId } = await seedConnectionAndSession(
				app,
				userId,
				"a".repeat(64)
			);
			// Pas d'attachCli — le tunnel n'est pas actif.
			const res = await app.inject({
				method: "GET",
				url: `/api/db-connections/${connectionId}/schema`,
				headers: { cookie }
			});
			expect(res.statusCode).toBe(503);
			const body = res.json() as { message?: string };
			expect(body.message).toMatch(/sqlnest connect|CLI/i);
		});

		test("GET /schema happy path — introspect renvoyé après réponse CLI", async () => {
			const { cookie, userId } = await createTestUser(
				app,
				"dave@example.com",
				"dave-dave-dave-dave-dave"
			);
			const cliPriv = ed25519.utils.randomSecretKey();
			const cliPub = ed25519.getPublicKey(cliPriv);
			const { connectionId, sessionId } = await seedConnectionAndSession(
				app,
				userId,
				bytesToHex(cliPub)
			);

			// Attach fake CLI qui répond au 1er backend → CLI frame.
			const fake = attachFakeCli(app, sessionId, userId, connectionId, cliPub);

			// Programme la fake CLI : quand on voit une frame arriver, on
			// répond avec la res correspondante. Ici, on écoute via
			// intervalle car les bytes sont push sync dans `sentToCli`.
			const fakeSchema = {
				engine: "postgres",
				collections: [{ name: "users", fields: [], source: "declared" }],
				relations: []
			};
			let respondedHandshake = false;
			const stopWatching = setInterval(() => {
				// Le 1er byte pack backend est le handshake. Sur le 1er
				// frame reçu, on répond avec notre handshake CLI.
				if (fake.sentToCli.length >= 1 && !respondedHandshake) {
					fake.replyHandshake();
					respondedHandshake = true;
				}
				// Le 2e frame est la req introspect. On répond une res.
				if (fake.sentToCli.length >= 2) {
					const req = decodeFrame(fake.sentToCli[1] as Uint8Array);
					if (req.header.kind === "req") {
						fake.replyRes(req.header.correlation_id, fakeSchema);
						clearInterval(stopWatching);
					}
				}
			}, 5);

			const res = await app.inject({
				method: "GET",
				url: `/api/db-connections/${connectionId}/schema`,
				headers: { cookie }
			});
			clearInterval(stopWatching);
			expect(res.statusCode).toBe(200);
			expect(res.json()).toEqual(fakeSchema);
		});

		test("POST /query happy path — runSnql arrive au CLI + res retournée", async () => {
			const { cookie, userId } = await createTestUser(
				app,
				"erin@example.com",
				"erin-erin-erin-erin-erin"
			);
			const cliPriv = ed25519.utils.randomSecretKey();
			const cliPub = ed25519.getPublicKey(cliPriv);
			const { connectionId, sessionId } = await seedConnectionAndSession(
				app,
				userId,
				bytesToHex(cliPub)
			);
			const fake = attachFakeCli(app, sessionId, userId, connectionId, cliPub);

			const fakeResult = { rowCount: 2, rows: [{ id: 1 }, { id: 2 }] };
			let respondedHandshake = false;
			const stopWatching = setInterval(() => {
				if (fake.sentToCli.length >= 1 && !respondedHandshake) {
					fake.replyHandshake();
					respondedHandshake = true;
				}
				if (fake.sentToCli.length >= 2) {
					const req = decodeFrame(fake.sentToCli[1] as Uint8Array);
					if (req.header.kind === "req") {
						fake.replyRes(req.header.correlation_id, fakeResult);
						clearInterval(stopWatching);
					}
				}
			}, 5);

			const res = await app.inject({
				method: "POST",
				url: `/api/db-connections/${connectionId}/query`,
				headers: { cookie, "content-type": "application/json" },
				payload: { source: "get users | limit 2" }
			});
			clearInterval(stopWatching);
			expect(res.statusCode).toBe(200);
			expect(res.json()).toEqual(fakeResult);
		});
	}
);
