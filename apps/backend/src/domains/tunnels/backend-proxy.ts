/**
 * Backend proxy tunnel — envoie une frame `req` signée au CLI via le
 * WS existant (relais backend) et attend la `res` correspondante.
 *
 * ─── Rôle ────────────────────────────────────────────────────────────
 * Permet aux routes HTTP `/api/db-connections/:id/{schema,query}`
 * d'exécuter des ops applicatives (introspect, runSnql) contre le CLI
 * distant, SANS transiter par un WS browser.
 *
 * Le backend est un peer WS "trusted" du CLI :
 *   - Il signe ses frames avec la keypair Ed25519 backend (dérivée
 *     d'AUTH_SECRET, voir `domains/backend-identity`).
 *   - Le CLI vérifie contre la pubkey backend qu'il a pin au
 *     démarrage (via `GET /api/backend/pubkey`).
 *
 * ─── Différence avec le browser ──────────────────────────────────────
 * Le browser fait de l'E2E (ECDH X25519 + AEAD ChaCha20-Poly1305) — le
 * backend ne peut PAS lire les payloads browser↔CLI.
 * Le backend proxy, lui, envoie du payload EN CLAIR au CLI — c'est du
 * "proxy interne", le canal est fait de bytes déjà côté serveur SQLNest.
 * Le CLI vérifie juste la signature Ed25519 backend (prouve que la
 * requête vient bien du backend légitime, pas d'un attaquant qui aurait
 * accès au socket WS).
 *
 * ─── Cycle de vie ────────────────────────────────────────────────────
 * Le proxy garde par tunnelId :
 *   - Un compteur monotone (`emitter`) pour anti-replay.
 *   - Un flag "handshake envoyé" (une fois par session tunnel).
 *   - Une pending Map `correlation_id → { resolve, reject, timer }`.
 * À la déconnexion CLI, tout est purgé (subscribe unsubscribe).
 */

import {
	createEmitterCounter,
	decodeFrame,
	type EmitterCounterState,
	encodeFrame,
	encodeHandshakePayload,
	type Frame,
	type FrameHeader,
	generateSessionNonce,
	nextCounter,
	PROTOCOL_VERSION,
	signFrame
} from "@sqlnest/tunnel-protocol";
import { pack, unpack } from "msgpackr";
import type { BackendKeypair } from "../backend-identity/keypair";
import type { TunnelRegistry } from "./session/registry";

/** Op envoyée du backend au CLI. Même shape que côté browser. */
export type BackendProxyOp =
	| { readonly op: "ping" }
	| { readonly op: "introspect" }
	| { readonly op: "runSnql"; readonly src: string };

export type BackendProxyResult =
	| { readonly ok: true; readonly data: unknown }
	| { readonly ok: false; readonly error: string };

export interface SendReqOptions {
	readonly timeoutMs?: number;
}

/** Erreurs discriminées pour que la route HTTP mappe vers le bon status. */
export class NoTunnelError extends Error {
	constructor(tunnelId: string) {
		super(`no active CLI tunnel for tunnel_id=${tunnelId}`);
		this.name = "NoTunnelError";
	}
}
export class TunnelTimeoutError extends Error {
	constructor(correlationId: string, ms: number) {
		super(`tunnel req ${correlationId} timeout after ${ms}ms`);
		this.name = "TunnelTimeoutError";
	}
}
/**
 * Détail structuré d'une erreur Postgres remontée par le CLI (Phase 3a).
 * Shape libre côté transport (msgpackr) ; validation à la frontière HTTP via
 * le schéma Zod `PgErrorInfoSchema` dans `domains/db-connections/proxy-schema.ts`.
 */
export type PgErrorPayload = Record<string, unknown>;

export class TunnelCliError extends Error {
	readonly cliMessage: string;
	/** Détail Postgres — présent quand la cause est une erreur `pg` côté CLI.
	 *  Absent pour toute autre erreur CLI (connect refused, config, etc.). */
	readonly pgError?: PgErrorPayload;
	constructor(cliMessage: string, pgError?: PgErrorPayload) {
		super(`CLI returned error: ${cliMessage}`);
		this.name = "TunnelCliError";
		this.cliMessage = cliMessage;
		if (pgError !== undefined) {
			this.pgError = pgError;
		}
	}
}

export interface BackendProxy {
	sendReq(
		tunnelId: string,
		op: BackendProxyOp,
		options?: SendReqOptions
	): Promise<unknown>;
	/** Cleanup complet — désinscrit tous les subscribers, reject les
	 *  pendings. À appeler au shutdown Fastify (`onClose`). */
	dispose(): void;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export interface CreateBackendProxyOptions {
	readonly registry: TunnelRegistry;
	readonly backendKeypair: BackendKeypair;
	readonly now?: () => number;
	readonly newCorrelationId?: () => string;
}

interface TunnelState {
	readonly tunnelId: string;
	emitter: EmitterCounterState;
	ourSessionNonce: Uint8Array;
	handshakeSent: boolean;
	cliPubkey: Uint8Array | null;
	cliSessionNonce: Uint8Array | null;
	/** id du socket CLI qui a répondu au dernier handshake. Sur reconnect
	 *  (Ctrl-C puis `sqlnest connect` de nouveau, ou auto-resume), le
	 *  registry attache un nouveau socket avec un id différent — le state
	 *  précédent (handshakeSent = true) est stale et il faut refaire un
	 *  handshake sinon le CLI rejette la 1re frame. */
	cliSocketId: string | null;
	pending: Map<
		string,
		{
			resolve: (v: unknown) => void;
			reject: (e: unknown) => void;
			timer: ReturnType<typeof setTimeout>;
		}
	>;
	unsubscribe: () => void;
}

export function createBackendProxy(
	opts: CreateBackendProxyOptions
): BackendProxy {
	const now = opts.now ?? Date.now;
	const newCorrelationId = opts.newCorrelationId ?? defaultCorrelationId;
	const states = new Map<string, TunnelState>();

	function ensureState(tunnelId: string): TunnelState {
		let state = states.get(tunnelId);
		if (state) return state;
		state = {
			tunnelId,
			emitter: createEmitterCounter(),
			ourSessionNonce: generateSessionNonce(),
			handshakeSent: false,
			cliPubkey: null,
			cliSessionNonce: null,
			cliSocketId: null,
			pending: new Map(),
			unsubscribe: () => {
				// Placeholder — overwritten juste après.
			}
		};
		state.unsubscribe = opts.registry.subscribeCliFrames(tunnelId, (bytes) =>
			// biome-ignore lint/style/noNonNullAssertion: state is defined
			handleCliFrame(state!, bytes)
		);
		states.set(tunnelId, state);
		return state;
	}

	function handleCliFrame(state: TunnelState, bytes: Uint8Array): void {
		let frame: Frame;
		try {
			frame = decodeFrame(bytes);
		} catch {
			return; // frame corrompue — ignore
		}
		// Le backend proxy ne s'intéresse qu'aux frames DU CLI destinées
		// à lui (frames CLI → browser sont broadcast à tous les subs, on
		// filtre par correlation_id présent dans notre pending).
		if (frame.header.dir !== "cli") return;
		if (frame.header.kind === "handshake") {
			try {
				const hs = unpack(frame.payload) as {
					ed25519_pubkey?: Uint8Array | Buffer;
					session_nonce?: Uint8Array | Buffer;
				};
				const pub = hs.ed25519_pubkey;
				const nonce = hs.session_nonce;
				if (!pub || !nonce) return;
				state.cliPubkey = toU8(pub);
				state.cliSessionNonce = toU8(nonce);
			} catch {
				// ignore
			}
			return;
		}
		if (frame.header.kind !== "res" && frame.header.kind !== "err") return;
		const pending = state.pending.get(frame.header.correlation_id);
		if (!pending) return; // pas pour nous
		clearTimeout(pending.timer);
		state.pending.delete(frame.header.correlation_id);
		let payload: unknown;
		try {
			payload = unpack(frame.payload);
		} catch (err) {
			pending.reject(err);
			return;
		}
		if (frame.header.kind === "err") {
			const msg =
				payload != null && typeof payload === "object" && "error" in payload
					? String((payload as { error?: unknown }).error)
					: "unknown CLI error";
			pending.reject(new TunnelCliError(msg, extractPgError(payload)));
			return;
		}
		// `res` : payload = RemoteResult (`{ok:true, data}` OU `{ok:false, error, pgError?}`).
		if (
			payload != null &&
			typeof payload === "object" &&
			"ok" in payload &&
			(payload as { ok?: unknown }).ok === false &&
			"error" in payload
		) {
			pending.reject(
				new TunnelCliError(
					String((payload as { error?: unknown }).error),
					extractPgError(payload)
				)
			);
			return;
		}
		if (
			payload != null &&
			typeof payload === "object" &&
			"ok" in payload &&
			(payload as { ok?: unknown }).ok === true &&
			"data" in payload
		) {
			pending.resolve((payload as { data: unknown }).data);
			return;
		}
		pending.resolve(payload);
	}

	function emitFrame(
		state: TunnelState,
		kind: FrameHeader["kind"],
		correlationId: string,
		payload: Uint8Array
	): void {
		const header: FrameHeader = {
			v: PROTOCOL_VERSION,
			dir: "backend",
			correlation_id: correlationId,
			kind,
			ts: now(),
			ctr: nextCounter(state.emitter),
			...(state.cliSessionNonce != null
				? { session_nonce: bytesToHex(state.cliSessionNonce) }
				: {})
		};
		const sig = signFrame(header, payload, opts.backendKeypair.privateKey);
		const frame: Frame = { header, payload, signature: sig };
		const bytes = encodeFrame(frame);
		opts.registry.routeToCliFromBackend(state.tunnelId, bytes);
	}

	function sendHandshake(state: TunnelState): void {
		const payload = encodeHandshakePayload({
			role: "backend",
			ed25519_pubkey: opts.backendKeypair.publicKey,
			session_nonce: state.ourSessionNonce
		});
		emitFrame(state, "handshake", "handshake", payload);
		state.handshakeSent = true;
	}

	return {
		async sendReq(tunnelId, op, options) {
			const slot = opts.registry.getSlot(tunnelId);
			if (!slot || !slot.cli) throw new NoTunnelError(tunnelId);
			const state = ensureState(tunnelId);
			// Si le socket CLI a changé (reconnect via auto-resume ou fresh
			// pair), le peer côté CLI a une map `peers` vide — il faut
			// refaire un handshake sinon la 1re frame req est rejetée. On
			// reset aussi le nonce + counter pour éviter tout replay avec
			// l'ancienne session.
			if (state.cliSocketId !== slot.cli.id) {
				state.handshakeSent = false;
				state.cliPubkey = null;
				state.cliSessionNonce = null;
				state.ourSessionNonce = generateSessionNonce();
				state.emitter = createEmitterCounter();
				state.cliSocketId = slot.cli.id;
			}
			if (!state.handshakeSent) sendHandshake(state);

			const correlationId = newCorrelationId();
			const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => {
					state.pending.delete(correlationId);
					reject(new TunnelTimeoutError(correlationId, timeoutMs));
				}, timeoutMs);
				state.pending.set(correlationId, { resolve, reject, timer });

				const payloadPack = pack(op) as Uint8Array | Buffer;
				const payload =
					payloadPack instanceof Uint8Array && !Buffer.isBuffer(payloadPack)
						? payloadPack
						: new Uint8Array(payloadPack);
				emitFrame(state, "req", correlationId, payload);
			});
		},

		dispose() {
			for (const [, state] of states) {
				for (const [, p] of state.pending) {
					clearTimeout(p.timer);
					p.reject(new Error("proxy disposed"));
				}
				state.pending.clear();
				state.unsubscribe();
			}
			states.clear();
		}
	};
}

// ─── Utilitaires ──────────────────────────────────────────────────────

/**
 * Extrait un `pgError` du payload wire (Phase 3a). Le CLI ajoute cet objet à
 * côté de `error: string` sur `{ok:false}` quand la cause est une erreur `pg`.
 * On garde la shape en `Record<string, unknown>` — la validation stricte est
 * faite plus loin par le schéma Zod à la frontière HTTP.
 */
function extractPgError(payload: unknown): PgErrorPayload | undefined {
	if (payload == null || typeof payload !== "object") return undefined;
	const pgError = (payload as { pgError?: unknown }).pgError;
	if (pgError == null || typeof pgError !== "object") return undefined;
	return pgError as PgErrorPayload;
}

function toU8(raw: Uint8Array | Buffer): Uint8Array {
	if (raw instanceof Uint8Array && !Buffer.isBuffer(raw)) return raw;
	return new Uint8Array(raw);
}

function bytesToHex(bytes: Uint8Array): string {
	let s = "";
	for (const b of bytes) s += b.toString(16).padStart(2, "0");
	return s;
}

const CORRELATION_LEN = 22;
function defaultCorrelationId(): string {
	const uuid = globalThis.crypto?.randomUUID?.() ?? fallbackRandomHex();
	return uuid.replace(/-/g, "").slice(0, CORRELATION_LEN);
}
function fallbackRandomHex(): string {
	const b = new Uint8Array(16);
	globalThis.crypto?.getRandomValues?.(b);
	return bytesToHex(b);
}
