/**
 * `BrowserTunnelClient` — client tunnel côté browser.
 *
 * ─── Rôle ─────────────────────────────────────────────────────────────
 *   1. Ouvre WS `/api/tunnels/by-connection/:connectionId/browser`
 *      (cookie de session Better Auth attaché automatiquement).
 *   2. Génère 2 keypairs éphémères (Ed25519 + X25519) — jetées à la
 *      fermeture.
 *   3. Envoie handshake signé avec ses 2 pubkeys + nonce.
 *   4. Reçoit handshake CLI :
 *      - Vérifie que la pubkey Ed25519 annoncée matche le PIN externe
 *        (`cliEd25519PubKey`, obtenu via API HTTP AVANT ouverture WS).
 *      - Dérive la shared key ECDH pour l'E2E.
 *   5. `send(op)` : chiffre AEAD → signe → envoie ; attend un `res` avec
 *      le même `correlation_id`. Timeout 30s par défaut.
 *
 * ─── Sécurité E2E ─────────────────────────────────────────────────────
 * Les payloads applicatifs sont chiffrés ChaCha20-Poly1305 avec la clé
 * dérivée d'ECDH X25519. Le backend voit passer des bytes opaques.
 * Le `header` du frame reste en clair (routing) mais aucune info
 * sensible n'y transite — juste `correlation_id`, `kind`, `ctr`, `ts`.
 *
 * ─── Ce qui viendra plus tard ────────────────────────────────────────
 *   - Hook React `useTunnel()` — Bloc 8 quand le dashboard s'y branche.
 *   - Broadcast/subscribe : listener pour les frames server-push (pas
 *     encore utilisées).
 *   - Reconnexion automatique — le hook React la gérera avec `useEffect`.
 */

import { ed25519 } from "@noble/curves/ed25519.js";
import {
	checkAndAdvance,
	createEmitterCounter,
	createPeerCounter,
	decodeFrame,
	decodeHandshakePayload,
	decryptPayload,
	deriveSharedKey,
	type EmitterCounterState,
	encodeFrame,
	encodeHandshakePayload,
	encryptPayload,
	type Frame,
	type FrameHeader,
	generateSessionNonce,
	generateX25519Keypair,
	nextCounter,
	type PeerCounterState,
	PROTOCOL_VERSION,
	signFrame,
	verifyFrame
} from "@sqlnest/tunnel-protocol";
import { pack, unpack } from "msgpackr";

export type RemoteOp =
	| { readonly op: "ping" }
	| { readonly op: "introspect" }
	| { readonly op: "runSnql"; readonly src: string };

export type TunnelStatus =
	| "connecting"
	| "handshaking"
	| "ready"
	| "closed"
	| "error";

export interface CreateBrowserTunnelClientOptions {
	/** URL complète `ws://.../api/tunnels/by-connection/:id/browser`. */
	readonly wsUrl: string;
	/** Pubkey Ed25519 du CLI (32 bytes). Obtenue via API HTTP AVANT
	 *  d'ouvrir le WS — permet le pinning : refuse tout handshake dont
	 *  la pubkey Ed25519 n'est pas exactement celle-ci. */
	readonly cliEd25519PubKey: Uint8Array;
	/** Timeout par requête (ms). Défaut 30 000. */
	readonly reqTimeoutMs?: number;
	/** Injection WebSocket (test avec mock). */
	readonly WebSocketImpl?: typeof WebSocket;
	/** Injection horloge (test). */
	readonly now?: () => number;
	/** Injection uuid (test — pour correlation_id stable). */
	readonly newCorrelationId?: () => string;
	/** Callback état — utile pour l'UI. */
	readonly onStatus?: (status: TunnelStatus) => void;
	/** Callback erreur — utile pour surface + log. */
	readonly onError?: (err: unknown) => void;
}

export interface BrowserTunnelClient {
	status(): TunnelStatus;
	send(op: RemoteOp): Promise<unknown>;
	close(): void;
}

const DEFAULT_REQ_TIMEOUT_MS = 30_000;
const DEFAULT_UUID_LEN = 22;

export function createBrowserTunnelClient(
	opts: CreateBrowserTunnelClientOptions
): BrowserTunnelClient {
	const WsImpl = opts.WebSocketImpl ?? WebSocket;
	const now = opts.now ?? Date.now;
	const newCorrelationId = opts.newCorrelationId ?? defaultCorrelationId;
	const reqTimeoutMs = opts.reqTimeoutMs ?? DEFAULT_REQ_TIMEOUT_MS;

	// Keypairs éphémères — jetés à la fermeture.
	const edPriv = ed25519.utils.randomSecretKey();
	const edPub = ed25519.getPublicKey(edPriv);
	const xkp = generateX25519Keypair();
	const ourSessionNonce = generateSessionNonce();

	let sharedKey: Uint8Array | null = null;
	let peerSessionNonce: Uint8Array | null = null;
	const emitter: EmitterCounterState = createEmitterCounter();
	const peerCounter: PeerCounterState = createPeerCounter();
	let currentStatus: TunnelStatus = "connecting";
	const pending = new Map<
		string,
		{
			resolve: (v: unknown) => void;
			reject: (e: unknown) => void;
			timer: ReturnType<typeof setTimeout>;
		}
	>();

	const socket = new WsImpl(opts.wsUrl);
	// L'API browser retourne un ArrayBuffer, pas un Blob, pour minimiser
	// la copie.
	socket.binaryType = "arraybuffer";

	function updateStatus(next: TunnelStatus): void {
		currentStatus = next;
		opts.onStatus?.(next);
	}

	socket.addEventListener("open", () => {
		updateStatus("handshaking");
		try {
			const payload = encodeHandshakePayload({
				role: "browser",
				ed25519_pubkey: edPub,
				x25519_pubkey: xkp.publicKey,
				session_nonce: ourSessionNonce
			});
			emit("handshake", "handshake", payload);
		} catch (err) {
			opts.onError?.(err);
			updateStatus("error");
		}
	});

	socket.addEventListener("message", (ev) => {
		try {
			handleIncoming(new Uint8Array(ev.data as ArrayBuffer));
		} catch (err) {
			opts.onError?.(err);
		}
	});

	socket.addEventListener("close", () => {
		// Si on est déjà en "error" (pin mismatch, sig invalide), on ne
		// masque pas cette info par un simple "closed" — l'UI a besoin
		// de savoir POURQUOI ça s'est fermé.
		if (currentStatus !== "error") {
			updateStatus("closed");
		}
		for (const [, entry] of pending) {
			clearTimeout(entry.timer);
			entry.reject(new Error("tunnel closed"));
		}
		pending.clear();
	});

	socket.addEventListener("error", (ev) => {
		opts.onError?.(ev);
		updateStatus("error");
	});

	function handleIncoming(bytes: Uint8Array): void {
		let frame: Frame;
		try {
			frame = decodeFrame(bytes);
		} catch (err) {
			opts.onError?.(err);
			return;
		}

		if (frame.header.kind === "handshake") {
			handleHandshake(frame);
			return;
		}

		// Sig + counter + skew.
		if (!verifyFrame(frame, opts.cliEd25519PubKey)) {
			opts.onError?.(new Error("signature invalide sur frame CLI"));
			return;
		}
		const advance = checkAndAdvance(
			peerCounter,
			frame.header.ctr,
			frame.header.ts,
			now()
		);
		if (!advance.ok) {
			opts.onError?.(new Error(`frame rejetée: ${advance.reason}`));
			return;
		}
		if (sharedKey == null) {
			opts.onError?.(new Error("frame avant handshake — ignorée"));
			return;
		}

		const correlationId = frame.header.correlation_id;
		const entry = pending.get(correlationId);
		if (!entry) {
			// Frame orpheline — pas de req en cours. On log et on ignore.
			return;
		}

		let clear: Uint8Array;
		try {
			clear = decryptPayload(sharedKey, frame.header, frame.payload);
		} catch (err) {
			clearTimeout(entry.timer);
			pending.delete(correlationId);
			entry.reject(err);
			return;
		}

		let result: unknown;
		try {
			result = unpack(clear);
		} catch (err) {
			clearTimeout(entry.timer);
			pending.delete(correlationId);
			entry.reject(err);
			return;
		}

		clearTimeout(entry.timer);
		pending.delete(correlationId);
		if (frame.header.kind === "err") {
			entry.reject(result);
		} else {
			entry.resolve(result);
		}
	}

	function handleHandshake(frame: Frame): void {
		let payload: ReturnType<typeof decodeHandshakePayload>;
		try {
			payload = decodeHandshakePayload(frame.payload);
		} catch (err) {
			opts.onError?.(err);
			updateStatus("error");
			return;
		}
		// PIN CHECK — la pubkey annoncée doit matcher exactement celle
		// obtenue via API HTTP (out-of-band).
		if (!bytesEqual(payload.ed25519_pubkey, opts.cliEd25519PubKey)) {
			opts.onError?.(new Error("CLI Ed25519 pubkey ne matche pas le pin"));
			updateStatus("error");
			socket.close();
			return;
		}
		if (payload.x25519_pubkey == null) {
			opts.onError?.(
				new Error("handshake CLI sans x25519_pubkey — E2E impossible")
			);
			updateStatus("error");
			return;
		}
		// Handshake self-signed, verify.
		if (!verifyFrame(frame, opts.cliEd25519PubKey)) {
			opts.onError?.(new Error("signature du handshake CLI invalide"));
			updateStatus("error");
			return;
		}
		try {
			sharedKey = deriveSharedKey(
				xkp.privateKey,
				payload.x25519_pubkey,
				xkp.publicKey
			);
			peerSessionNonce = payload.session_nonce;
			updateStatus("ready");
		} catch (err) {
			opts.onError?.(err);
			updateStatus("error");
		}
	}

	function emit(
		kind: FrameHeader["kind"],
		correlationId: string,
		payload: Uint8Array
	): void {
		const header: FrameHeader = {
			v: PROTOCOL_VERSION,
			dir: "browser",
			correlation_id: correlationId,
			kind,
			ts: now(),
			ctr: nextCounter(emitter),
			...(peerSessionNonce != null
				? { session_nonce: bytesToHex(peerSessionNonce) }
				: {})
		};
		const sig = signFrame(header, payload, edPriv);
		const frame: Frame = { header, payload, signature: sig };
		socket.send(encodeFrame(frame));
	}

	return {
		status: () => currentStatus,
		send(op) {
			return new Promise((resolve, reject) => {
				if (currentStatus !== "ready" || sharedKey == null) {
					reject(new Error(`tunnel non prêt (status=${currentStatus})`));
					return;
				}
				const correlationId = newCorrelationId();
				const clear = pack(op) as Uint8Array | Buffer;
				const clearBytes =
					clear instanceof Uint8Array && !isNodeBuffer(clear)
						? clear
						: new Uint8Array(clear);
				const preHeader: FrameHeader = {
					v: PROTOCOL_VERSION,
					dir: "browser",
					correlation_id: correlationId,
					kind: "req",
					ts: now(),
					ctr: emitter.next, // le vrai ctr sera défini dans emit
					...(peerSessionNonce != null
						? { session_nonce: bytesToHex(peerSessionNonce) }
						: {})
				};
				let cipher: Uint8Array;
				try {
					cipher = encryptPayload(sharedKey, preHeader, clearBytes);
				} catch (err) {
					reject(err);
					return;
				}
				const timer = setTimeout(() => {
					pending.delete(correlationId);
					reject(new Error(`req ${correlationId} timeout`));
				}, reqTimeoutMs);
				pending.set(correlationId, { resolve, reject, timer });
				emit("req", correlationId, cipher);
			});
		},
		close() {
			socket.close();
			for (const [, entry] of pending) {
				clearTimeout(entry.timer);
				entry.reject(new Error("client closed"));
			}
			pending.clear();
			updateStatus("closed");
		}
	};
}

// ─── Utilitaires ──────────────────────────────────────────────────────

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) {
		// biome-ignore lint/style/noNonNullAssertion: length bound
		diff |= (a[i]! ^ b[i]!) & 0xff;
	}
	return diff === 0;
}

function bytesToHex(bytes: Uint8Array): string {
	let s = "";
	for (const b of bytes) s += b.toString(16).padStart(2, "0");
	return s;
}

function isNodeBuffer(x: Uint8Array): boolean {
	// biome-ignore lint/suspicious/noExplicitAny: Node runtime detect
	return typeof (x as any).readInt8 === "function";
}

function defaultCorrelationId(): string {
	// crypto.randomUUID() est standard browser + Node 22+. On tronque
	// à ~22 chars pour un identifier compact.
	const uuid = globalThis.crypto?.randomUUID?.() ?? fallback();
	return uuid.replace(/-/g, "").slice(0, DEFAULT_UUID_LEN);
}

function fallback(): string {
	const buf = new Uint8Array(16);
	globalThis.crypto?.getRandomValues?.(buf);
	return bytesToHex(buf);
}
