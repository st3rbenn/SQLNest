/**
 * Tests unit — `BrowserTunnelClient`.
 * Mock WebSocket + fake CLI qui joue handshake + res chiffré.
 */

import { ed25519 } from "@noble/curves/ed25519.js";
import {
	createEmitterCounter,
	createPeerCounter,
	decodeFrame,
	decodeHandshakePayload,
	decryptPayload,
	deriveSharedKey,
	encodeFrame,
	encodeHandshakePayload,
	encryptPayload,
	generateSessionNonce,
	generateX25519Keypair,
	nextCounter,
	PROTOCOL_VERSION,
	signFrame
} from "@sqlnest/tunnel-protocol";
import { pack, unpack } from "msgpackr";
import { describe, expect, test, vi } from "vitest";
import {
	createBrowserTunnelClient,
	type RemoteOp,
	type TunnelStatus
} from "./tunnel-client";

/** Mock WebSocket global — capture les frames envoyées, permet
 *  d'injecter des frames reçues. */
class MockWebSocket {
	static instances: MockWebSocket[] = [];
	url: string;
	binaryType = "arraybuffer" as BinaryType;
	sent: Uint8Array[] = [];
	listeners: Record<string, ((ev: unknown) => void)[]> = {};
	readyState = 0;

	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;

	constructor(url: string) {
		this.url = url;
		MockWebSocket.instances.push(this);
	}

	addEventListener(type: string, cb: (ev: unknown) => void): void {
		if (!this.listeners[type]) this.listeners[type] = [];
		this.listeners[type].push(cb);
	}

	send(bytes: Uint8Array | ArrayBuffer): void {
		if (bytes instanceof ArrayBuffer) {
			this.sent.push(new Uint8Array(bytes));
		} else {
			this.sent.push(bytes);
		}
	}

	close(): void {
		this.readyState = MockWebSocket.CLOSED;
		this.trigger("close", { code: 1000, reason: "" });
	}

	trigger(event: string, ev: unknown): void {
		const handlers = this.listeners[event];
		if (!handlers) return;
		for (const h of handlers) h(ev);
	}

	simulateOpen(): void {
		this.readyState = MockWebSocket.OPEN;
		this.trigger("open", {});
	}

	simulateMessage(bytes: Uint8Array): void {
		this.trigger("message", { data: bytes.buffer });
	}
}

function makeCliPeer() {
	const edPriv = ed25519.utils.randomSecretKey();
	const edPub = ed25519.getPublicKey(edPriv);
	const xkp = generateX25519Keypair();
	const nonce = generateSessionNonce();
	const emitter = createEmitterCounter();
	const peerCounter = createPeerCounter();
	return { edPriv, edPub, xkp, nonce, emitter, peerCounter };
}

/** Construit une frame handshake du CLI (self-signed). */
function cliHandshakeFrame(
	cli: ReturnType<typeof makeCliPeer>,
	now: number
): Uint8Array {
	const payload = encodeHandshakePayload({
		role: "cli",
		ed25519_pubkey: cli.edPub,
		x25519_pubkey: cli.xkp.publicKey,
		session_nonce: cli.nonce
	});
	const header = {
		v: PROTOCOL_VERSION,
		dir: "cli" as const,
		correlation_id: "handshake",
		kind: "handshake" as const,
		ts: now,
		ctr: nextCounter(cli.emitter)
	};
	const sig = signFrame(header, payload, cli.edPriv);
	return encodeFrame({ header, payload, signature: sig });
}

/** Construit une frame res chiffrée + signée du CLI. */
function cliResFrame(
	cli: ReturnType<typeof makeCliPeer>,
	sharedKey: Uint8Array,
	correlationId: string,
	result: unknown,
	browserSessionNonce: Uint8Array,
	now: number,
	kind: "res" | "err" = "res"
): Uint8Array {
	const clearPack = pack(result) as Uint8Array | Buffer;
	const clear =
		clearPack instanceof Uint8Array && !Buffer.isBuffer(clearPack)
			? clearPack
			: new Uint8Array(clearPack);
	const preHeader = {
		v: PROTOCOL_VERSION,
		dir: "cli" as const,
		correlation_id: correlationId,
		kind,
		ts: now,
		ctr: cli.emitter.next,
		session_nonce: Buffer.from(browserSessionNonce).toString("hex")
	};
	const ct = encryptPayload(sharedKey, preHeader, clear);
	const header = { ...preHeader, ctr: nextCounter(cli.emitter) };
	const sig = signFrame(header, ct, cli.edPriv);
	return encodeFrame({ header, payload: ct, signature: sig });
}

describe("BrowserTunnelClient — handshake", () => {
	test("envoie handshake browser à l'ouverture", () => {
		const cli = makeCliPeer();
		MockWebSocket.instances = [];
		const client = createBrowserTunnelClient({
			wsUrl: "ws://localhost:4000/api/tunnels/by-connection/x/browser",
			cliEd25519PubKey: cli.edPub,
			WebSocketImpl: MockWebSocket as unknown as typeof WebSocket,
			now: () => 1_700_000_000_000
		});
		expect(client.status()).toBe("connecting");
		const ws = MockWebSocket.instances[0];
		if (!ws) throw new Error("no ws instance");
		ws.simulateOpen();
		expect(client.status()).toBe("handshaking");
		expect(ws.sent.length).toBe(1);
		const frame = decodeFrame(ws.sent[0] as Uint8Array);
		expect(frame.header.dir).toBe("browser");
		expect(frame.header.kind).toBe("handshake");
		const hs = decodeHandshakePayload(frame.payload);
		expect(hs.role).toBe("browser");
		expect(hs.x25519_pubkey?.length).toBe(32);
	});

	test("handshake CLI → status ready + shared key dérivée", () => {
		const cli = makeCliPeer();
		MockWebSocket.instances = [];
		const client = createBrowserTunnelClient({
			wsUrl: "ws://localhost:4000/api/tunnels/by-connection/x/browser",
			cliEd25519PubKey: cli.edPub,
			WebSocketImpl: MockWebSocket as unknown as typeof WebSocket,
			now: () => 1_700_000_000_000
		});
		const ws = MockWebSocket.instances[0];
		if (!ws) throw new Error("no ws");
		ws.simulateOpen();
		ws.simulateMessage(cliHandshakeFrame(cli, 1_700_000_000_000));
		expect(client.status()).toBe("ready");
	});

	test("handshake CLI avec pubkey ≠ pin → error + close", () => {
		const cli = makeCliPeer();
		const impostor = makeCliPeer();
		MockWebSocket.instances = [];
		const onError = vi.fn();
		const client = createBrowserTunnelClient({
			wsUrl: "ws://localhost:4000/api/tunnels/by-connection/x/browser",
			cliEd25519PubKey: cli.edPub, // PIN
			WebSocketImpl: MockWebSocket as unknown as typeof WebSocket,
			now: () => 1_700_000_000_000,
			onError
		});
		const ws = MockWebSocket.instances[0];
		if (!ws) throw new Error("no ws");
		ws.simulateOpen();
		// L'impostor envoie SON handshake (self-signed avec sa clé).
		ws.simulateMessage(cliHandshakeFrame(impostor, 1_700_000_000_000));
		expect(client.status()).toBe("error");
		expect(onError).toHaveBeenCalled();
	});
});

describe("BrowserTunnelClient — send + res chiffré", () => {
	test("happy path : send(op) → CLI res → résout Promise avec result", async () => {
		const cli = makeCliPeer();
		MockWebSocket.instances = [];
		let correlationCounter = 0;
		const now = () => 1_700_000_000_000;
		const client = createBrowserTunnelClient({
			wsUrl: "ws://localhost:4000/api/tunnels/by-connection/x/browser",
			cliEd25519PubKey: cli.edPub,
			WebSocketImpl: MockWebSocket as unknown as typeof WebSocket,
			now,
			newCorrelationId: () => `corr-${++correlationCounter}`
		});
		const ws = MockWebSocket.instances[0];
		if (!ws) throw new Error("no ws");
		ws.simulateOpen();
		ws.simulateMessage(cliHandshakeFrame(cli, now()));
		expect(client.status()).toBe("ready");

		// Décode le handshake browser envoyé pour récupérer sa nonce
		// et sa X25519 pubkey — nécessaire pour dériver la clé côté CLI.
		const browserHs = decodeFrame(ws.sent[0] as Uint8Array);
		const browserPayload = decodeHandshakePayload(browserHs.payload);
		if (!browserPayload.x25519_pubkey) throw new Error("no x25519");
		const sharedKey = deriveSharedKey(
			cli.xkp.privateKey,
			browserPayload.x25519_pubkey,
			cli.xkp.publicKey
		);

		// Envoie une req.
		const promise = client.send({ op: "ping" } as RemoteOp);
		// L'index 1 est la 1re req (index 0 = handshake).
		const reqFrame = decodeFrame(ws.sent[1] as Uint8Array);
		expect(reqFrame.header.kind).toBe("req");
		// Le payload est CHIFFRÉ — decrypt.
		const clear = decryptPayload(sharedKey, reqFrame.header, reqFrame.payload);
		expect(unpack(clear)).toEqual({ op: "ping" });

		// CLI répond chiffré.
		ws.simulateMessage(
			cliResFrame(
				cli,
				sharedKey,
				reqFrame.header.correlation_id,
				{ pong: true },
				browserPayload.session_nonce,
				now()
			)
		);
		const result = await promise;
		expect(result).toEqual({ pong: true });
	});

	test("res avec kind=err → reject la Promise", async () => {
		const cli = makeCliPeer();
		MockWebSocket.instances = [];
		const now = () => 1_700_000_000_000;
		let corr = 0;
		const client = createBrowserTunnelClient({
			wsUrl: "ws://x/",
			cliEd25519PubKey: cli.edPub,
			WebSocketImpl: MockWebSocket as unknown as typeof WebSocket,
			now,
			newCorrelationId: () => `c-${++corr}`
		});
		const ws = MockWebSocket.instances[0];
		if (!ws) throw new Error("no ws");
		ws.simulateOpen();
		ws.simulateMessage(cliHandshakeFrame(cli, now()));

		const browserHs = decodeFrame(ws.sent[0] as Uint8Array);
		const browserPayload = decodeHandshakePayload(browserHs.payload);
		if (!browserPayload.x25519_pubkey) throw new Error("no x25519");
		const sharedKey = deriveSharedKey(
			cli.xkp.privateKey,
			browserPayload.x25519_pubkey,
			cli.xkp.publicKey
		);

		const p = client.send({ op: "ping" } as RemoteOp);
		const reqFrame = decodeFrame(ws.sent[1] as Uint8Array);
		ws.simulateMessage(
			cliResFrame(
				cli,
				sharedKey,
				reqFrame.header.correlation_id,
				{ ok: false, error: "boom" },
				browserPayload.session_nonce,
				now(),
				"err"
			)
		);
		await expect(p).rejects.toEqual({ ok: false, error: "boom" });
	});

	test("send avant status=ready → rejette immédiatement", async () => {
		const cli = makeCliPeer();
		MockWebSocket.instances = [];
		const client = createBrowserTunnelClient({
			wsUrl: "ws://x/",
			cliEd25519PubKey: cli.edPub,
			WebSocketImpl: MockWebSocket as unknown as typeof WebSocket,
			now: () => 1_700_000_000_000
		});
		// Pas d'open, pas de handshake.
		await expect(client.send({ op: "ping" } as RemoteOp)).rejects.toThrow(
			/non prêt/
		);
	});
});

describe("BrowserTunnelClient — statuts / close", () => {
	test("callback onStatus émis pour chaque transition", () => {
		const cli = makeCliPeer();
		MockWebSocket.instances = [];
		const statuses: TunnelStatus[] = [];
		const client = createBrowserTunnelClient({
			wsUrl: "ws://x/",
			cliEd25519PubKey: cli.edPub,
			WebSocketImpl: MockWebSocket as unknown as typeof WebSocket,
			now: () => 1_700_000_000_000,
			onStatus: (s) => statuses.push(s)
		});
		const ws = MockWebSocket.instances[0];
		if (!ws) throw new Error("no ws");
		ws.simulateOpen();
		ws.simulateMessage(cliHandshakeFrame(cli, 1_700_000_000_000));
		client.close();
		expect(statuses).toEqual(["handshaking", "ready", "closed", "closed"]);
	});
});
