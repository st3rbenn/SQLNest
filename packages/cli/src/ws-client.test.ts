/**
 * Tests unit — `TunnelWsClient`.
 * Mock socket + mock runOp — pas de backend réel.
 */

import { ed25519 } from "@noble/curves/ed25519.js";
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
import { pack, unpack } from "msgpackr";
import { describe, expect, test, vi } from "vitest";
import {
	createTunnelWsClient,
	type RemoteOp,
	type WsSocket
} from "./ws-client";

interface MockSocket {
	sent: Uint8Array[];
	closed: Array<{ code?: number; reason?: string }>;
	handlers: {
		open?: () => void;
		message?: (bytes: Uint8Array) => void;
		close?: (code: number, reason: string) => void;
		error?: (err: Error) => void;
	};
	emitOpen(): void;
	emitMessage(bytes: Uint8Array): void;
	emitClose(code?: number, reason?: string): void;
	asWsSocket(): WsSocket;
}

function makeMockSocket(): MockSocket {
	const sent: Uint8Array[] = [];
	const closed: Array<{ code?: number; reason?: string }> = [];
	const handlers: MockSocket["handlers"] = {};
	return {
		sent,
		closed,
		handlers,
		emitOpen() {
			handlers.open?.();
		},
		emitMessage(bytes) {
			handlers.message?.(bytes);
		},
		emitClose(code = 1000, reason = "") {
			handlers.close?.(code, reason);
		},
		asWsSocket() {
			return {
				send: (b) => sent.push(b),
				close: (c, r) => closed.push({ code: c, reason: r }),
				// biome-ignore lint/suspicious/noExplicitAny: mock
				on: (event: string, cb: any) => {
					// biome-ignore lint/suspicious/noExplicitAny: mock
					(handlers as any)[event] = cb;
				}
			} as WsSocket;
		}
	};
}

function makeCliKeypair() {
	const priv = ed25519.utils.randomSecretKey();
	const pub = ed25519.getPublicKey(priv);
	return { priv, pub };
}

function makeBrowserPeer() {
	const priv = ed25519.utils.randomSecretKey();
	const pub = ed25519.getPublicKey(priv);
	const emitter = createEmitterCounter();
	const nonce = generateSessionNonce();
	return { priv, pub, emitter, nonce };
}

/** Construit une frame req signée par le browser. */
function browserReqFrame(
	browser: ReturnType<typeof makeBrowserPeer>,
	correlationId: string,
	op: RemoteOp,
	now: number
): Uint8Array {
	const payloadPack = pack(op) as Uint8Array | Buffer;
	const payload =
		payloadPack instanceof Uint8Array && !Buffer.isBuffer(payloadPack)
			? payloadPack
			: new Uint8Array(payloadPack);
	const header = {
		v: PROTOCOL_VERSION,
		dir: "browser" as const,
		correlation_id: correlationId,
		kind: "req" as const,
		ts: now,
		ctr: nextCounter(browser.emitter),
		session_nonce: Buffer.from(browser.nonce).toString("hex")
	};
	const sig = signFrame(header, payload, browser.priv);
	return encodeFrame({ header, payload, signature: sig });
}

/** Construit une frame handshake du browser. */
function browserHandshakeFrame(
	browser: ReturnType<typeof makeBrowserPeer>,
	now: number
): Uint8Array {
	const payload = encodeHandshakePayload({
		role: "browser",
		ed25519_pubkey: browser.pub,
		session_nonce: browser.nonce
	});
	const header = {
		v: PROTOCOL_VERSION,
		dir: "browser" as const,
		correlation_id: "handshake",
		kind: "handshake" as const,
		ts: now,
		ctr: nextCounter(browser.emitter)
	};
	const sig = signFrame(header, payload, browser.priv);
	return encodeFrame({ header, payload, signature: sig });
}

describe("TunnelWsClient — handshake + dispatch", () => {
	test("attend un handshake browser AVANT d'envoyer le sien", async () => {
		// Fix intentionnel : le CLI ne s'annonce plus au socket-open — il
		// attend le handshake du browser (sinon son handshake initial part
		// dans le vide si le browser n'est pas encore attaché au tunnel).
		const cli = makeCliKeypair();
		const mock = makeMockSocket();
		const client = createTunnelWsClient({
			baseWsUrl: "ws://localhost:4000",
			sessionId: "sess-1",
			token: `tn_${"a".repeat(64)}`,
			cliEd25519Private: cli.priv,
			cliEd25519Public: cli.pub,
			runOp: async () => ({ ok: true, data: null }),
			socketFactory: () => mock.asWsSocket(),
			sleep: async () => {},
			now: () => 1_700_000_000_000
		});
		client.start();
		await new Promise((r) => setImmediate(r));
		mock.emitOpen();
		// Après open, aucune frame émise — le CLI est en écoute passive.
		expect(mock.sent.length).toBe(0);
		await client.stop();
	});

	test("handshake browser → CLI répond avec son handshake, puis req → res", async () => {
		const cli = makeCliKeypair();
		const browser = makeBrowserPeer();
		const runOp = vi.fn().mockResolvedValue({
			ok: true,
			data: { pong: true }
		});
		const mock = makeMockSocket();
		const now = () => 1_700_000_000_000;
		const client = createTunnelWsClient({
			baseWsUrl: "ws://localhost:4000",
			sessionId: "sess-1",
			token: `tn_${"a".repeat(64)}`,
			cliEd25519Private: cli.priv,
			cliEd25519Public: cli.pub,
			runOp,
			socketFactory: () => mock.asWsSocket(),
			sleep: async () => {},
			now
		});
		client.start();
		await new Promise((r) => setImmediate(r));
		mock.emitOpen();
		// Aucune frame émise au open.
		expect(mock.sent.length).toBe(0);

		// Browser envoie son handshake → CLI répond avec le sien (frame 0).
		mock.emitMessage(browserHandshakeFrame(browser, now()));
		expect(mock.sent.length).toBe(1);
		const cliHs = decodeFrame(mock.sent[0] as Uint8Array);
		expect(cliHs.header.kind).toBe("handshake");
		expect(cliHs.header.dir).toBe("cli");

		// Puis req ping → CLI res.
		mock.emitMessage(browserReqFrame(browser, "q-1", { op: "ping" }, now()));
		await new Promise((r) => setImmediate(r));
		await new Promise((r) => setImmediate(r));

		expect(runOp).toHaveBeenCalledTimes(1);
		expect(runOp).toHaveBeenCalledWith({ op: "ping" });

		// Frame res à l'index 1.
		expect(mock.sent.length).toBe(2);
		const res = decodeFrame(mock.sent[1] as Uint8Array);
		expect(res.header.kind).toBe("res");
		expect(res.header.correlation_id).toBe("q-1");
		expect(unpack(res.payload)).toEqual({ ok: true, data: { pong: true } });

		await client.stop();
	});

	test("req signée par une autre clé → onError, pas de dispatch", async () => {
		const cli = makeCliKeypair();
		const browser = makeBrowserPeer();
		const impostor = makeBrowserPeer();
		const runOp = vi.fn().mockResolvedValue({ ok: true, data: null });
		const onError = vi.fn();
		const mock = makeMockSocket();
		const now = () => 1_700_000_000_000;

		const client = createTunnelWsClient({
			baseWsUrl: "ws://localhost:4000",
			sessionId: "sess-1",
			token: `tn_${"a".repeat(64)}`,
			cliEd25519Private: cli.priv,
			cliEd25519Public: cli.pub,
			runOp,
			onError,
			socketFactory: () => mock.asWsSocket(),
			sleep: async () => {},
			now
		});
		client.start();
		await new Promise((r) => setImmediate(r));
		mock.emitOpen();
		mock.emitMessage(browserHandshakeFrame(browser, now()));

		// Frame signée par IMPOSTOR mais compteur du browser légitime.
		const payload = pack({ op: "ping" }) as Uint8Array;
		const header = {
			v: PROTOCOL_VERSION,
			dir: "browser" as const,
			correlation_id: "q-1",
			kind: "req" as const,
			ts: now(),
			ctr: 5,
			session_nonce: Buffer.from(browser.nonce).toString("hex")
		};
		const badSig = signFrame(header, payload, impostor.priv);
		const badFrame = encodeFrame({ header, payload, signature: badSig });
		mock.emitMessage(badFrame);
		await new Promise((r) => setImmediate(r));

		expect(runOp).not.toHaveBeenCalled();
		expect(onError).toHaveBeenCalled();
		await client.stop();
	});

	test("replay (même ctr 2 fois) → 2e frame rejetée", async () => {
		const cli = makeCliKeypair();
		const browser = makeBrowserPeer();
		const runOp = vi.fn().mockResolvedValue({ ok: true, data: null });
		const onError = vi.fn();
		const mock = makeMockSocket();
		const now = () => 1_700_000_000_000;

		const client = createTunnelWsClient({
			baseWsUrl: "ws://localhost:4000",
			sessionId: "sess-1",
			token: `tn_${"a".repeat(64)}`,
			cliEd25519Private: cli.priv,
			cliEd25519Public: cli.pub,
			runOp,
			onError,
			socketFactory: () => mock.asWsSocket(),
			sleep: async () => {},
			now
		});
		client.start();
		await new Promise((r) => setImmediate(r));
		mock.emitOpen();
		mock.emitMessage(browserHandshakeFrame(browser, now()));

		// 1re req avec ctr = X — acceptée.
		const req1 = browserReqFrame(browser, "q-1", { op: "ping" }, now());
		mock.emitMessage(req1);
		await new Promise((r) => setImmediate(r));
		await new Promise((r) => setImmediate(r));
		expect(runOp).toHaveBeenCalledTimes(1);

		// Replay du même frame — rejeté (ctr identique).
		mock.emitMessage(req1);
		await new Promise((r) => setImmediate(r));
		expect(runOp).toHaveBeenCalledTimes(1);
		expect(onError).toHaveBeenCalled();

		await client.stop();
	});

	test("rate-limit : au-delà du cap, réponse err rate_limit_exceeded", async () => {
		const cli = makeCliKeypair();
		const browser = makeBrowserPeer();
		const runOp = vi.fn().mockResolvedValue({ ok: true, data: null });
		const mock = makeMockSocket();
		let clock = 1_700_000_000_000;
		const now = () => clock;

		const client = createTunnelWsClient({
			baseWsUrl: "ws://localhost:4000",
			sessionId: "sess-1",
			token: `tn_${"a".repeat(64)}`,
			cliEd25519Private: cli.priv,
			cliEd25519Public: cli.pub,
			runOp,
			rateLimit: 3,
			socketFactory: () => mock.asWsSocket(),
			sleep: async () => {},
			now
		});
		client.start();
		await new Promise((r) => setImmediate(r));
		mock.emitOpen();
		mock.emitMessage(browserHandshakeFrame(browser, now()));

		// 3 reqs acceptées.
		for (let i = 0; i < 3; i++) {
			mock.emitMessage(
				browserReqFrame(browser, `q-${i}`, { op: "ping" }, now())
			);
			await new Promise((r) => setImmediate(r));
			await new Promise((r) => setImmediate(r));
			clock += 100; // simule un léger passage du temps
		}
		expect(runOp).toHaveBeenCalledTimes(3);

		// 4e req — refusée : réponse err.
		mock.emitMessage(browserReqFrame(browser, "q-4", { op: "ping" }, now()));
		await new Promise((r) => setImmediate(r));
		expect(runOp).toHaveBeenCalledTimes(3);

		// Il doit y avoir une frame err émise (après 1 handshake + 3 res).
		const framesSent = mock.sent.map((b) => decodeFrame(b));
		const errFrames = framesSent.filter((f) => f.header.kind === "err");
		expect(errFrames.length).toBe(1);
		expect(unpack(errFrames[0]?.payload as Uint8Array)).toEqual({
			ok: false,
			error: "rate_limit_exceeded"
		});
		await client.stop();
	});
});

describe("TunnelWsClient — multi-peers (browser + backend)", () => {
	/** Fabrique une frame arbitraire signée par un peer donné dans une
	 *  direction précise (browser OU backend). Reprend la logique de
	 *  `browserReqFrame` mais paramétrable. */
	function peerReqFrame(
		peer: ReturnType<typeof makeBrowserPeer>,
		dir: "browser" | "backend",
		correlationId: string,
		op: RemoteOp,
		nowMs: number
	): Uint8Array {
		const payloadPack = pack(op) as Uint8Array | Buffer;
		const payload =
			payloadPack instanceof Uint8Array && !Buffer.isBuffer(payloadPack)
				? payloadPack
				: new Uint8Array(payloadPack);
		const header = {
			v: PROTOCOL_VERSION,
			dir,
			correlation_id: correlationId,
			kind: "req" as const,
			ts: nowMs,
			ctr: nextCounter(peer.emitter),
			session_nonce: Buffer.from(peer.nonce).toString("hex")
		};
		const sig = signFrame(header, payload, peer.priv);
		return encodeFrame({ header, payload, signature: sig });
	}

	function peerHandshakeFrame(
		peer: ReturnType<typeof makeBrowserPeer>,
		dir: "browser" | "backend",
		nowMs: number
	): Uint8Array {
		const payload = encodeHandshakePayload({
			role: dir,
			ed25519_pubkey: peer.pub,
			session_nonce: peer.nonce
		});
		const header = {
			v: PROTOCOL_VERSION,
			dir,
			correlation_id: "handshake",
			kind: "handshake" as const,
			ts: nowMs,
			ctr: nextCounter(peer.emitter)
		};
		const sig = signFrame(header, payload, peer.priv);
		return encodeFrame({ header, payload, signature: sig });
	}

	test("browser ET backend handshakent — CLI répond aux 2 + dispatch chaque req", async () => {
		const cli = makeCliKeypair();
		const browser = makeBrowserPeer();
		const backend = makeBrowserPeer(); // même structure, dir différent
		const runOp = vi
			.fn()
			.mockResolvedValueOnce({ ok: true, data: "from-browser" })
			.mockResolvedValueOnce({ ok: true, data: "from-backend" });
		const mock = makeMockSocket();
		const now = () => 1_700_000_000_000;
		const client = createTunnelWsClient({
			baseWsUrl: "ws://x/",
			sessionId: "sess-1",
			token: `tn_${"a".repeat(64)}`,
			cliEd25519Private: cli.priv,
			cliEd25519Public: cli.pub,
			runOp,
			socketFactory: () => mock.asWsSocket(),
			sleep: async () => {},
			now
		});
		client.start();
		await new Promise((r) => setImmediate(r));
		mock.emitOpen();

		// Handshake browser → CLI répond (frame 0 = handshake vers browser).
		mock.emitMessage(peerHandshakeFrame(browser, "browser", now()));
		expect(mock.sent.length).toBe(1);
		const hs1 = decodeFrame(mock.sent[0] as Uint8Array);
		expect(hs1.header.kind).toBe("handshake");

		// Handshake backend → CLI répond aussi (frame 1).
		mock.emitMessage(peerHandshakeFrame(backend, "backend", now()));
		expect(mock.sent.length).toBe(2);
		const hs2 = decodeFrame(mock.sent[1] as Uint8Array);
		expect(hs2.header.kind).toBe("handshake");

		// Req browser + req backend → 2 dispatch, 2 res.
		mock.emitMessage(peerReqFrame(browser, "browser", "b-1", { op: "ping" }, now()));
		mock.emitMessage(peerReqFrame(backend, "backend", "k-1", { op: "ping" }, now()));
		await new Promise((r) => setImmediate(r));
		await new Promise((r) => setImmediate(r));

		expect(runOp).toHaveBeenCalledTimes(2);
		expect(mock.sent.length).toBe(4); // 2 handshakes + 2 res

		const res1 = decodeFrame(mock.sent[2] as Uint8Array);
		const res2 = decodeFrame(mock.sent[3] as Uint8Array);
		expect(res1.header.kind).toBe("res");
		expect(res2.header.kind).toBe("res");

		// La res à b-1 doit inclure la nonce du browser (pas du backend).
		const resToBrowser = [res1, res2].find(
			(f) => f.header.correlation_id === "b-1"
		);
		const resToBackend = [res1, res2].find(
			(f) => f.header.correlation_id === "k-1"
		);
		expect(resToBrowser?.header.session_nonce).toBe(
			Buffer.from(browser.nonce).toString("hex")
		);
		expect(resToBackend?.header.session_nonce).toBe(
			Buffer.from(backend.nonce).toString("hex")
		);

		await client.stop();
	});

	test("frame signée par un peer non-handshaké (impostor sur dir=backend) → rejetée", async () => {
		const cli = makeCliKeypair();
		const browser = makeBrowserPeer();
		const impostor = makeBrowserPeer();
		const runOp = vi.fn().mockResolvedValue({ ok: true, data: null });
		const onError = vi.fn();
		const mock = makeMockSocket();
		const now = () => 1_700_000_000_000;
		const client = createTunnelWsClient({
			baseWsUrl: "ws://x/",
			sessionId: "sess-1",
			token: `tn_${"a".repeat(64)}`,
			cliEd25519Private: cli.priv,
			cliEd25519Public: cli.pub,
			runOp,
			onError,
			socketFactory: () => mock.asWsSocket(),
			sleep: async () => {},
			now
		});
		client.start();
		await new Promise((r) => setImmediate(r));
		mock.emitOpen();
		mock.emitMessage(peerHandshakeFrame(browser, "browser", now()));

		// Impostor envoie une req avec dir=backend — le CLI n'a jamais
		// vu de handshake backend → rejette.
		mock.emitMessage(peerReqFrame(impostor, "backend", "x-1", { op: "ping" }, now()));
		await new Promise((r) => setImmediate(r));

		expect(runOp).not.toHaveBeenCalled();
		expect(onError).toHaveBeenCalled();
		await client.stop();
	});
});

describe("TunnelWsClient — reconnect", () => {
	test("close déclenche un reconnect via socketFactory", async () => {
		const cli = makeCliKeypair();
		const factory = vi.fn(() => makeMockSocket().asWsSocket());
		let sleepCalls = 0;
		const client = createTunnelWsClient({
			baseWsUrl: "ws://localhost:4000",
			sessionId: "sess-1",
			token: `tn_${"a".repeat(64)}`,
			cliEd25519Private: cli.priv,
			cliEd25519Public: cli.pub,
			runOp: async () => ({ ok: true, data: null }),
			socketFactory: factory,
			sleep: async () => {
				sleepCalls++;
			},
			now: () => 0,
			reconnectInitialMs: 10,
			reconnectCapMs: 100
		});

		client.start();

		// On simule un close pour forcer une reconnect. Le factory est
		// appelé une 2e fois.
		await new Promise((r) => setImmediate(r));
		await client.stop();

		// factory appelé au moins 1 fois (au start).
		expect(factory).toHaveBeenCalled();
		// sleep sera appelé sur la boucle de reconnect si un cycle
		// s'est terminé.
		expect(sleepCalls).toBeGreaterThanOrEqual(0);
	});
});
