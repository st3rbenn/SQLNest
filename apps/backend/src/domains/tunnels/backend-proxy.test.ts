/**
 * Tests unit — `createBackendProxy`.
 * Mock registry + fake CLI (émet manuellement les frames res signées).
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
import { pack } from "msgpackr";
import { describe, expect, test, vi } from "vitest";
import { deriveBackendKeypair } from "../backend-identity/keypair";
import {
	createBackendProxy,
	NoTunnelError,
	TunnelCliError,
	TunnelTimeoutError
} from "./backend-proxy";
import type {
	AttachBrowserResult,
	RegistrySocket,
	TunnelRegistry,
	TunnelSlot
} from "./session/registry";

const AUTH_SECRET = "test-secret-super-long-value-32-chars-min-XX";
const TUNNEL_ID = "tunnel-1";

/** Mock registry — capture les bytes envoyés au CLI, expose une méthode
 *  pour injecter une frame CLI dans les subscribers. */
function makeMockRegistry(slotPresent: boolean): {
	registry: TunnelRegistry;
	sentToCli: Uint8Array[];
	emitCliFrame: (bytes: Uint8Array) => void;
} {
	const sentToCli: Uint8Array[] = [];
	const subs = new Map<string, Set<(b: Uint8Array) => void>>();
	const cliSock: RegistrySocket = {
		id: "cli",
		send: (b) => sentToCli.push(b),
		close: () => undefined
	};
	const slot: TunnelSlot = {
		tunnelId: TUNNEL_ID,
		userId: "user",
		connectionId: "conn",
		cliFingerprint: "fp",
		cli: slotPresent ? cliSock : null,
		browsers: new Map()
	};
	const registry: TunnelRegistry = {
		attachCli: vi.fn(),
		detachCli: vi.fn(),
		attachBrowser: vi.fn(() => ({ ok: true }) as AttachBrowserResult),
		detachBrowser: vi.fn(),
		routeToCliFromBrowser: vi.fn(() => true),
		routeToCliFromBackend: (tunnelId: string, bytes: Uint8Array) => {
			if (tunnelId !== TUNNEL_ID) return false;
			if (!slotPresent) return false;
			sentToCli.push(bytes);
			return true;
		},
		routeToBrowsersFromCli: vi.fn(() => 0),
		subscribeCliFrames: (tid, cb) => {
			let set = subs.get(tid);
			if (!set) {
				set = new Set();
				subs.set(tid, set);
			}
			set.add(cb);
			return () => set?.delete(cb);
		},
		getSlot: (tid) => (tid === TUNNEL_ID && slotPresent ? slot : undefined),
		findByConnection: () => undefined,
		size: () => (slotPresent ? 1 : 0)
	};
	return {
		registry,
		sentToCli,
		emitCliFrame: (bytes) => {
			const set = subs.get(TUNNEL_ID);
			if (!set) return;
			for (const cb of set) cb(bytes);
		}
	};
}

/** Fake CLI keypair + helper pour construire une frame CLI signée. */
function makeFakeCli() {
	const priv = ed25519.utils.randomSecretKey();
	const pub = ed25519.getPublicKey(priv);
	const emitter = createEmitterCounter();
	const nonce = generateSessionNonce();
	return {
		priv,
		pub,
		emitter,
		nonce,
		handshakeFrame: (nowMs: number): Uint8Array => {
			const payload = encodeHandshakePayload({
				role: "cli",
				ed25519_pubkey: pub,
				session_nonce: nonce
			});
			const header = {
				v: PROTOCOL_VERSION,
				dir: "cli" as const,
				correlation_id: "handshake",
				kind: "handshake" as const,
				ts: nowMs,
				ctr: nextCounter(emitter)
			};
			const sig = signFrame(header, payload, priv);
			return encodeFrame({ header, payload, signature: sig });
		},
		resFrame: (
			correlationId: string,
			data: unknown,
			nowMs: number,
			backendSessionNonce: Uint8Array
		): Uint8Array => {
			const p = pack({ ok: true, data }) as Uint8Array | Buffer;
			const payload =
				p instanceof Uint8Array && !Buffer.isBuffer(p) ? p : new Uint8Array(p);
			const header = {
				v: PROTOCOL_VERSION,
				dir: "cli" as const,
				correlation_id: correlationId,
				kind: "res" as const,
				ts: nowMs,
				ctr: nextCounter(emitter),
				session_nonce: Buffer.from(backendSessionNonce).toString("hex")
			};
			const sig = signFrame(header, payload, priv);
			return encodeFrame({ header, payload, signature: sig });
		}
	};
}

describe("createBackendProxy — happy path", () => {
	test("sendReq happy — handshake + req signés backend, res parsée", async () => {
		const { registry, sentToCli, emitCliFrame } = makeMockRegistry(true);
		const backendKp = deriveBackendKeypair(AUTH_SECRET);
		const fakeCli = makeFakeCli();
		const now = () => 1_700_000_000_000;
		const proxy = createBackendProxy({
			registry,
			backendKeypair: backendKp,
			now,
			newCorrelationId: () => "corr-1"
		});

		const promise = proxy.sendReq(TUNNEL_ID, { op: "ping" });

		// Après start : 2 frames envoyées (handshake + req).
		expect(sentToCli.length).toBe(2);
		const hs = decodeFrame(sentToCli[0] as Uint8Array);
		expect(hs.header.kind).toBe("handshake");
		expect(hs.header.dir).toBe("backend");
		const req = decodeFrame(sentToCli[1] as Uint8Array);
		expect(req.header.kind).toBe("req");
		expect(req.header.correlation_id).toBe("corr-1");

		// Récupère la nonce backend (mise dans le header handshake payload).
		const backendNonce = new Uint8Array(16); // ne sert pas — le CLI ne l'utilise pas ici, mais on met une valeur pour la structure.
		// Simule la res CLI signée.
		emitCliFrame(
			fakeCli.resFrame("corr-1", { pong: true }, now(), backendNonce)
		);

		const result = await promise;
		expect(result).toEqual({ pong: true });

		proxy.dispose();
	});

	test("un 2e sendReq ne renvoie pas de handshake (déjà envoyé)", async () => {
		const { registry, sentToCli, emitCliFrame } = makeMockRegistry(true);
		const backendKp = deriveBackendKeypair(AUTH_SECRET);
		const fakeCli = makeFakeCli();
		const now = () => 1_700_000_000_000;
		let corr = 0;
		const proxy = createBackendProxy({
			registry,
			backendKeypair: backendKp,
			now,
			newCorrelationId: () => `c-${++corr}`
		});

		const p1 = proxy.sendReq(TUNNEL_ID, { op: "ping" });
		emitCliFrame(
			fakeCli.resFrame("c-1", { first: true }, now(), new Uint8Array(16))
		);
		await p1;

		const p2 = proxy.sendReq(TUNNEL_ID, { op: "ping" });
		// Frame count : hs(0) + req(1) + [res(pas côté sent, in-process)] + req(2) = 3
		expect(sentToCli.length).toBe(3);
		expect(decodeFrame(sentToCli[2] as Uint8Array).header.kind).toBe("req");

		emitCliFrame(
			fakeCli.resFrame("c-2", { second: true }, now(), new Uint8Array(16))
		);
		expect(await p2).toEqual({ second: true });
		proxy.dispose();
	});
});

describe("createBackendProxy — erreurs", () => {
	test("aucun tunnel actif → NoTunnelError", async () => {
		const { registry } = makeMockRegistry(false);
		const backendKp = deriveBackendKeypair(AUTH_SECRET);
		const proxy = createBackendProxy({
			registry,
			backendKeypair: backendKp
		});
		await expect(proxy.sendReq(TUNNEL_ID, { op: "ping" })).rejects.toThrow(
			NoTunnelError
		);
		proxy.dispose();
	});

	test("timeout → TunnelTimeoutError", async () => {
		const { registry } = makeMockRegistry(true);
		const backendKp = deriveBackendKeypair(AUTH_SECRET);
		const proxy = createBackendProxy({
			registry,
			backendKeypair: backendKp,
			newCorrelationId: () => "corr-x"
		});
		await expect(
			proxy.sendReq(TUNNEL_ID, { op: "ping" }, { timeoutMs: 10 })
		).rejects.toThrow(TunnelTimeoutError);
		proxy.dispose();
	});

	test("CLI répond avec err payload → TunnelCliError", async () => {
		const { registry, emitCliFrame } = makeMockRegistry(true);
		const backendKp = deriveBackendKeypair(AUTH_SECRET);
		const now = () => 1_700_000_000_000;
		const fakeCli = makeFakeCli();
		const proxy = createBackendProxy({
			registry,
			backendKeypair: backendKp,
			now,
			newCorrelationId: () => "corr-err"
		});
		const p = proxy.sendReq(TUNNEL_ID, { op: "ping" });
		// Envoi une frame res mais avec payload {ok:false, error:"boom"}.
		const errPack = pack({ ok: false, error: "boom" }) as Uint8Array | Buffer;
		const errPayload =
			errPack instanceof Uint8Array && !Buffer.isBuffer(errPack)
				? errPack
				: new Uint8Array(errPack);
		const header = {
			v: PROTOCOL_VERSION,
			dir: "cli" as const,
			correlation_id: "corr-err",
			kind: "res" as const,
			ts: now(),
			ctr: nextCounter(fakeCli.emitter),
			session_nonce: Buffer.from(new Uint8Array(16)).toString("hex")
		};
		const sig = signFrame(header, errPayload, fakeCli.priv);
		emitCliFrame(encodeFrame({ header, payload: errPayload, signature: sig }));
		await expect(p).rejects.toThrow(TunnelCliError);
		proxy.dispose();
	});

	test("dispose reject les pendings + unsubscribe", async () => {
		const { registry } = makeMockRegistry(true);
		const backendKp = deriveBackendKeypair(AUTH_SECRET);
		const proxy = createBackendProxy({
			registry,
			backendKeypair: backendKp,
			newCorrelationId: () => "corr-1"
		});
		const p = proxy.sendReq(TUNNEL_ID, { op: "ping" }, { timeoutMs: 60_000 });
		proxy.dispose();
		await expect(p).rejects.toThrow(/disposed/);
	});
});
