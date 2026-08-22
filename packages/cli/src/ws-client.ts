/**
 * `TunnelWsClient` — client WS du CLI vers le backend.
 *
 * ─── Rôle ─────────────────────────────────────────────────────────────
 *   1. Ouvre WSS `/api/tunnels/:sessionId/cli?token=tn_...`.
 *   2. Envoie une frame `handshake` signée Ed25519 avec sa pubkey +
 *      pubkey X25519 (pour ECDH E2E avec browser plus tard).
 *   3. Reçoit des frames `req` du browser (relayées par le backend),
 *      les valide (sig + counter + skew), les dispatch au handler
 *      applicatif (`runOp`), puis répond avec une frame `res`.
 *   4. Reconnect automatique avec exponential backoff en cas de
 *      déconnexion — le tunnel reste "vivant" tant que le CLI tourne.
 *   5. Rate-limit local (leaky bucket) — cap défaut 60 ops/min, protège
 *      contre un browser mal intentionné qui inonderait le CLI.
 *
 * ─── Injection ────────────────────────────────────────────────────────
 * Tout est injectable pour test :
 *   - `socketFactory`  : crée un `WsSocket` (le vrai wrap `ws` de Node).
 *   - `runOp`          : dispatch applicatif (test = mock, prod = engine).
 *   - `sleep` / `now`  : contrôle du backoff + rate limit dans les tests.
 *   - `onError`        : hook pour surface les erreurs (log CLI).
 *
 * ─── Ce qui n'est PAS géré ici ────────────────────────────────────────
 *   - ECDH X25519 + AEAD ChaCha20-Poly1305 côté CLI. Le CLI voit les
 *     payloads applicatifs EN CLAIR pour l'instant (le E2E côté browser
 *     activera le chiffrement quand il sera prêt). Le protocole
 *     `@sqlnest/tunnel-protocol` supporte déjà le chiffrement.
 */

import {
	checkAndAdvance,
	createEmitterCounter,
	createPeerCounter,
	decodeFrame,
	type EmitterCounterState,
	encodeFrame,
	encodeHandshakePayload,
	type Frame,
	type FrameDir,
	type FrameHeader,
	generateSessionNonce,
	nextCounter,
	type PeerCounterState,
	PROTOCOL_VERSION,
	signFrame,
	verifyFrame
} from "@sqlnest/tunnel-protocol";
import type { PgErrorInfo } from "@sqlnest/engine";
import { pack, unpack } from "msgpackr";
import NodeWebSocket from "ws";

/** Op applicative reçue du browser (payload clair du frame req). */
export type RemoteOp =
	| { readonly op: "ping" }
	| { readonly op: "introspect" }
	| { readonly op: "runSnql"; readonly src: string };

/**
 * Résultat retourné par `runOp` — sérialisé dans le payload de `res`.
 *
 * `pgError` (optionnel) porte le détail structuré d'une erreur Postgres :
 * SQLSTATE, position, hint, colonne + les params bindés et leurs spans SNQL
 * source pour permettre au frontend de résoudre `$N` → token source à
 * souligner. Absent si la cause n'est pas une erreur `pg`.
 */
export type RemoteResult =
	| { readonly ok: true; readonly data: unknown }
	| {
			readonly ok: false;
			readonly error: string;
			readonly pgError?: PgErrorInfo;
	  };

/** Interface générique d'un socket WS — permet mock en test. */
export interface WsSocket {
	send(bytes: Uint8Array): void;
	close(code?: number, reason?: string): void;
	on(event: "open", cb: () => void): void;
	on(event: "message", cb: (bytes: Uint8Array) => void): void;
	on(event: "close", cb: (code: number, reason: string) => void): void;
	on(event: "error", cb: (err: Error) => void): void;
}

export interface TunnelWsClientOptions {
	/** URL de base (`ws://localhost:4000`). */
	readonly baseWsUrl: string;
	/** ID de la session tunnel (path du WS). */
	readonly sessionId: string;
	/** Bearer `tn_...` — query string du WS. */
	readonly token: string;
	/** Ed25519 privkey CLI, 32 bytes. */
	readonly cliEd25519Private: Uint8Array;
	/** Ed25519 pubkey CLI, 32 bytes. Envoyée au handshake. */
	readonly cliEd25519Public: Uint8Array;
	/** Handler applicatif appelé pour chaque `req` valide. */
	readonly runOp: (op: RemoteOp) => Promise<RemoteResult>;
	/** Cap ops/min (leaky bucket). Défaut 60. */
	readonly rateLimit?: number;
	/** Injection socket (test). */
	readonly socketFactory?: (url: string) => WsSocket;
	/** Injection sleep (test). */
	readonly sleep?: (ms: number) => Promise<void>;
	/** Injection clock (test). */
	readonly now?: () => number;
	/** Backoff initial (ms). Défaut 500. */
	readonly reconnectInitialMs?: number;
	/** Backoff cap (ms). Défaut 60_000. */
	readonly reconnectCapMs?: number;
	/** Callback erreur (log). */
	readonly onError?: (err: unknown) => void;
	/** Callback debug — appelé pour chaque frame émise/reçue. */
	readonly onFrame?: (direction: "in" | "out", frame: Frame) => void;
}

export interface TunnelWsClient {
	start(): void;
	stop(): Promise<void>;
	isConnected(): boolean;
}

const DEFAULT_RATE_LIMIT = 60;
const DEFAULT_BACKOFF_INITIAL = 500;
const DEFAULT_BACKOFF_CAP = 60_000;

/** Regex hissée top-level (règle Biome). */
const TRAILING_SLASH_RE = /\/+$/;

export function createTunnelWsClient(
	opts: TunnelWsClientOptions
): TunnelWsClient {
	const sleep = opts.sleep ?? defaultSleep;
	const now = opts.now ?? Date.now;
	const socketFactory = opts.socketFactory ?? defaultSocketFactory;
	const rateLimit = opts.rateLimit ?? DEFAULT_RATE_LIMIT;
	const backoffInitial = opts.reconnectInitialMs ?? DEFAULT_BACKOFF_INITIAL;
	const backoffCap = opts.reconnectCapMs ?? DEFAULT_BACKOFF_CAP;

	let stopped = false;
	let currentSocket: WsSocket | null = null;
	let backoff = backoffInitial;
	// État par session — reset à chaque nouvelle connexion.
	let emitter: EmitterCounterState = createEmitterCounter();
	let ourSessionNonce: Uint8Array = generateSessionNonce();
	/** État par peer distant (browser, backend). Chaque peer a sa pubkey,
	 *  son propre counter monotone et sa session_nonce à inclure quand on
	 *  lui répond. Le CLI accepte plusieurs peers concurrents sur le même
	 *  socket WS (frame.header.dir distingue). */
	const peers: Map<
		FrameDir,
		{
			publicKey: Uint8Array;
			counter: PeerCounterState;
			sessionNonce: Uint8Array;
		}
	> = new Map();
	/** correlation_id → dir du peer qui l'a émis. Permet à `res` de
	 *  cibler la bonne nonce/pubkey côté émission. */
	const pendingReqDir: Map<string, FrameDir> = new Map();
	const bucket = createLeakyBucket(rateLimit, now);

	async function loop(): Promise<void> {
		while (!stopped) {
			try {
				await connectOnce();
				backoff = backoffInitial; // succès → reset backoff
			} catch (err) {
				opts.onError?.(err);
			}
			if (stopped) break;
			await sleep(backoff);
			backoff = Math.min(backoff * 2, backoffCap);
		}
	}

	function connectOnce(): Promise<void> {
		return new Promise((resolve, reject) => {
			// Reset par-session state.
			emitter = createEmitterCounter();
			peers.clear();
			pendingReqDir.clear();
			ourSessionNonce = generateSessionNonce();

			const url = `${opts.baseWsUrl.replace(TRAILING_SLASH_RE, "")}/api/tunnels/${encodeURIComponent(opts.sessionId)}/cli?token=${encodeURIComponent(opts.token)}`;
			const sock = socketFactory(url);
			currentSocket = sock;

			// PAS d'envoi de handshake sur open — le CLI attend qu'un
			// browser (ou plusieurs) initie le handshake. Le CLI répond
			// alors avec son propre handshake (voir `handleIncoming`).
			// Ça évite qu'un handshake CLI initial soit émis dans le vide
			// quand aucun browser n'est encore attaché au tunnel.
			sock.on("open", () => {
				// no-op — le CLI est en écoute passive jusqu'au 1er
				// handshake browser.
			});

			sock.on("message", (bytes) => {
				handleIncoming(sock, bytes).catch((err) => opts.onError?.(err));
			});

			sock.on("close", (code, reason) => {
				currentSocket = null;
				// Une déco propre = flow normal, on résout et la boucle
				// externe décidera de retry.
				resolve();
				opts.onFrame?.("in", {
					header: {
						v: PROTOCOL_VERSION,
						dir: "backend",
						correlation_id: "close",
						kind: "err",
						ts: now(),
						ctr: -1 as unknown as number // marker debug seulement
					},
					payload: new TextEncoder().encode(
						JSON.stringify({ close: { code, reason } })
					),
					signature: null
				});
			});

			sock.on("error", (err) => {
				// Une erreur avant "close" — on log, la fermeture suivra.
				opts.onError?.(err);
				reject(err);
			});
		});
	}

	/** Envoie notre handshake CLI. `targetDir` détermine à quel peer on
	 *  répond — la nonce incluse dans le header sera celle de ce peer
	 *  (si connu). Pour un handshake initial (pas de peer connu), on
	 *  passe `undefined` pour omettre la nonce du header. */
	function sendHandshake(sock: WsSocket, targetDir?: FrameDir): void {
		const payload = encodeHandshakePayload({
			role: "cli",
			ed25519_pubkey: opts.cliEd25519Public,
			session_nonce: ourSessionNonce
		});
		emitFrame(sock, "handshake", "handshake", payload, targetDir);
	}

	async function handleIncoming(
		sock: WsSocket,
		bytes: Uint8Array
	): Promise<void> {
		let frame: Frame;
		try {
			frame = decodeFrame(bytes);
		} catch (err) {
			opts.onError?.(err);
			return;
		}
		opts.onFrame?.("in", frame);

		// Handshake d'un peer (browser ou backend). Le CLI peut en avoir
		// plusieurs simultanément — on stocke un état séparé par `dir` et
		// on répond avec notre handshake pour que le peer puisse pin
		// notre pubkey et (pour un browser) dériver l'ECDH.
		if (frame.header.kind === "handshake") {
			try {
				const hs = unpack(frame.payload) as {
					ed25519_pubkey?: Uint8Array | Buffer;
					session_nonce?: Uint8Array | Buffer;
				};
				const rawPub = hs.ed25519_pubkey;
				const rawNonce = hs.session_nonce;
				if (!rawPub || !rawNonce) {
					throw new Error("handshake: pubkey ou nonce manquants");
				}
				peers.set(frame.header.dir, {
					publicKey: toU8(rawPub),
					counter: createPeerCounter(),
					sessionNonce: toU8(rawNonce)
				});
			} catch (err) {
				opts.onError?.(err);
				return;
			}
			// Répond avec notre handshake ciblé sur ce peer précis.
			sendHandshake(sock, frame.header.dir);
			return;
		}

		// Toutes les autres frames DOIVENT venir d'un peer déjà handshaké
		// et être signées avec sa pubkey.
		const peer = peers.get(frame.header.dir);
		if (peer == null) {
			opts.onError?.(
				new Error(
					`frame de dir=${frame.header.dir} avant handshake — ignorée`
				)
			);
			return;
		}
		if (!verifyFrame(frame, peer.publicKey)) {
			opts.onError?.(new Error(`signature invalide (dir=${frame.header.dir})`));
			return;
		}
		const advance = checkAndAdvance(
			peer.counter,
			frame.header.ctr,
			frame.header.ts,
			now()
		);
		if (!advance.ok) {
			opts.onError?.(new Error(`frame rejetée: ${advance.reason}`));
			return;
		}

		if (frame.header.kind === "req") {
			// Mémorise le dir de l'émetteur pour que la res cible la
			// bonne nonce/pubkey à l'émission.
			pendingReqDir.set(frame.header.correlation_id, frame.header.dir);
			await handleReq(sock, frame);
			return;
		}
		// `ping` / `pong` / autres — silencieusement ignorés en MVP.
	}

	async function handleReq(sock: WsSocket, frame: Frame): Promise<void> {
		if (!bucket.tryConsume()) {
			respondErr(sock, frame.header.correlation_id, "rate_limit_exceeded");
			return;
		}

		let op: RemoteOp;
		try {
			op = unpack(frame.payload) as RemoteOp;
		} catch {
			respondErr(sock, frame.header.correlation_id, "invalid_op_payload");
			return;
		}

		let result: RemoteResult;
		try {
			result = await opts.runOp(op);
		} catch (err) {
			result = {
				ok: false,
				error: err instanceof Error ? err.message : String(err)
			};
		}

		const payload = pack(result) as Uint8Array | Buffer;
		const targetDir = pendingReqDir.get(frame.header.correlation_id);
		pendingReqDir.delete(frame.header.correlation_id);
		emitFrame(
			sock,
			"res",
			frame.header.correlation_id,
			payload instanceof Uint8Array && !Buffer.isBuffer(payload)
				? payload
				: new Uint8Array(payload),
			targetDir
		);
	}

	function respondErr(
		sock: WsSocket,
		correlationId: string,
		message: string
	): void {
		const payload = pack({ ok: false, error: message }) as Uint8Array | Buffer;
		const targetDir = pendingReqDir.get(correlationId);
		pendingReqDir.delete(correlationId);
		emitFrame(
			sock,
			"err",
			correlationId,
			payload instanceof Uint8Array && !Buffer.isBuffer(payload)
				? payload
				: new Uint8Array(payload),
			targetDir
		);
	}

	function emitFrame(
		sock: WsSocket,
		kind: FrameHeader["kind"],
		correlationId: string,
		payload: Uint8Array,
		targetDir?: FrameDir
	): void {
		// La nonce mise dans le header est celle du peer destinataire —
		// permet au peer de vérifier "cette frame m'est bien destinée".
		// Si aucun peer cible n'est connu (handshake initial), on omet.
		const nonce = targetDir ? peers.get(targetDir)?.sessionNonce : undefined;
		const header: FrameHeader = {
			v: PROTOCOL_VERSION,
			dir: "cli",
			correlation_id: correlationId,
			kind,
			ts: now(),
			ctr: nextCounter(emitter),
			...(nonce != null ? { session_nonce: bytesToHex(nonce) } : {})
		};
		const sig = signFrame(header, payload, opts.cliEd25519Private);
		const frame: Frame = { header, payload, signature: sig };
		opts.onFrame?.("out", frame);
		sock.send(encodeFrame(frame));
	}

	return {
		start() {
			void loop();
		},
		async stop() {
			stopped = true;
			if (currentSocket) {
				try {
					currentSocket.close(1000, "cli stop");
				} catch {
					// ignore
				}
			}
		},
		isConnected() {
			return currentSocket !== null;
		}
	};
}

// ─── Utilitaires ──────────────────────────────────────────────────────

function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultSocketFactory(url: string): WsSocket {
	const ws = new NodeWebSocket(url);
	// Le client `ws` de Node envoie des Buffer en mode default. On
	// normalise vers Uint8Array pour le contrat WsSocket.
	// biome-ignore lint/suspicious/noExplicitAny: cast interne — les 4 overloads
	// du contrat WsSocket sont typés par le caller.
	const on = (event: string, cb: (...args: any[]) => void): void => {
		if (event === "message") {
			ws.on("message", (data) => {
				const buf =
					data instanceof Buffer
						? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
						: new Uint8Array(0);
				cb(buf);
			});
		} else {
			// biome-ignore lint/suspicious/noExplicitAny: passthrough event
			ws.on(event as any, cb as any);
		}
	};
	return {
		send(bytes) {
			ws.send(bytes);
		},
		close(code, reason) {
			ws.close(code, reason);
		},
		on: on as WsSocket["on"]
	};
}

function toU8(raw: Uint8Array | Buffer): Uint8Array {
	if (raw instanceof Uint8Array && !Buffer.isBuffer(raw)) return raw;
	return new Uint8Array(raw);
}

function bytesToHex(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("hex");
}

// ─── Leaky bucket rate-limit ──────────────────────────────────────────

interface LeakyBucket {
	tryConsume(): boolean;
}

function createLeakyBucket(capPerMin: number, now: () => number): LeakyBucket {
	// Fenêtre glissante 1 min — tokens 1 par 60/cap seconds.
	const windowMs = 60_000;
	let tokens = capPerMin;
	let lastRefill = now();
	return {
		tryConsume() {
			const currentNow = now();
			const elapsed = currentNow - lastRefill;
			if (elapsed > 0) {
				const refill = (elapsed / windowMs) * capPerMin;
				tokens = Math.min(capPerMin, tokens + refill);
				lastRefill = currentNow;
			}
			if (tokens >= 1) {
				tokens -= 1;
				return true;
			}
			return false;
		}
	};
}
