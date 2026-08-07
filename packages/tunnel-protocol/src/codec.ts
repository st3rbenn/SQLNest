/**
 * Encodage/décodage des frames tunnel — MessagePack.
 *
 * ─── Format wire ──────────────────────────────────────────────────────
 * Une frame sur le wire = MessagePack.encode({
 *   h: <FrameHeader>,   // sérialisé récursivement en MessagePack
 *   p: <Uint8Array>,    // payload bytes (raw)
 *   s: <Uint8Array>     // signature bytes (64 bytes) ou null
 * })
 *
 * On garde des clés à un caractère pour minimiser l'overhead — chaque
 * frame porte des dizaines/centaines de milliers pour un resultset gros.
 *
 * ─── Sécurité ─────────────────────────────────────────────────────────
 * Le décodage valide STRICTEMENT le format : tout champ manquant ou de
 * type inattendu throw. Une frame malformée = attaque en cours ou bug —
 * refuser fort évite qu'un handler applicatif fasse confiance à un
 * partial parse.
 */

import { pack, unpack } from "msgpackr";
import {
	ED25519_SIG_LEN,
	type Frame,
	type FrameDir,
	type FrameHeader,
	type FrameKind,
	PROTOCOL_VERSION
} from "./types";

/** Valeurs valides de `header.dir` — freeze pour utilisation dans le type
 *  guard sans allocation.  */
const VALID_DIRS = new Set<FrameDir>(["cli", "browser", "backend"]);

/** Valeurs valides de `header.kind`. */
const VALID_KINDS = new Set<FrameKind>([
	"handshake",
	"req",
	"res",
	"err",
	"ping",
	"pong"
]);

/**
 * Sérialise une Frame vers l'octet-flux MessagePack qui va sur le wire.
 * Le caller garantit que la signature (si présente) a été calculée sur
 * le résultat de {@link canonicalizeForSigning}.
 */
export function encodeFrame(frame: Frame): Uint8Array {
	const encoded = pack({
		h: frame.header,
		p: frame.payload,
		s: frame.signature ?? null
	}) as Uint8Array | Buffer;
	// `pack` peut retourner un Buffer sous Node — normalise en Uint8Array
	// pour cohérence backend/browser (Buffer.prototype instanceof
	// Uint8Array est true mais le nom du type diffère, ce qui gêne
	// certains tests d'égalité).
	return encoded instanceof Uint8Array && !Buffer.isBuffer(encoded)
		? encoded
		: new Uint8Array(encoded);
}

/**
 * Désérialise une Frame depuis les bytes reçus. Throw si :
 *   - le MessagePack est cassé,
 *   - la structure ne matche pas `{ h, p, s }`,
 *   - le header n'a pas tous les champs requis avec les bons types,
 *   - la signature n'est ni null ni exactement 64 bytes.
 */
export function decodeFrame(bytes: Uint8Array): Frame {
	const raw = unpack(bytes) as unknown;
	if (raw == null || typeof raw !== "object") {
		throw new FrameDecodeError("frame doit être un objet MessagePack");
	}
	const obj = raw as Record<string, unknown>;
	if (!("h" in obj) || !("p" in obj)) {
		throw new FrameDecodeError("frame doit contenir les clés `h` et `p`");
	}
	const header = validateHeader(obj.h);
	const payload = validatePayload(obj.p);
	const signature = validateSignature(obj.s);
	return { header, payload, signature };
}

/**
 * Bytes canoniques signés par Ed25519 : `msgpack(header) || payload`.
 * Le signataire calcule sur ce buffer, le vérificateur le reconstruit.
 * Utilise `pack(header)` — même sérialisation que dans `encodeFrame`,
 * ce qui garantit que le signataire et le vérificateur voient les
 * mêmes bytes header.
 */
export function canonicalizeForSigning(
	header: FrameHeader,
	payload: Uint8Array
): Uint8Array {
	const headerBytes = pack(header) as Uint8Array | Buffer;
	const normalized =
		headerBytes instanceof Uint8Array && !Buffer.isBuffer(headerBytes)
			? headerBytes
			: new Uint8Array(headerBytes);
	const out = new Uint8Array(normalized.length + payload.length);
	out.set(normalized, 0);
	out.set(payload, normalized.length);
	return out;
}

export class FrameDecodeError extends Error {
	constructor(message: string) {
		super(`frame decode: ${message}`);
		this.name = "FrameDecodeError";
	}
}

function validateHeader(raw: unknown): FrameHeader {
	if (raw == null || typeof raw !== "object") {
		throw new FrameDecodeError("`h` doit être un objet");
	}
	const h = raw as Record<string, unknown>;

	if (h.v !== PROTOCOL_VERSION) {
		throw new FrameDecodeError(
			`version protocole ${String(h.v)} inconnue (attendu ${PROTOCOL_VERSION})`
		);
	}
	if (typeof h.dir !== "string" || !VALID_DIRS.has(h.dir as FrameDir)) {
		throw new FrameDecodeError(`\`dir\` invalide : ${String(h.dir)}`);
	}
	if (typeof h.correlation_id !== "string" || h.correlation_id.length === 0) {
		throw new FrameDecodeError("`correlation_id` requis (string non vide)");
	}
	if (typeof h.kind !== "string" || !VALID_KINDS.has(h.kind as FrameKind)) {
		throw new FrameDecodeError(`\`kind\` invalide : ${String(h.kind)}`);
	}
	if (typeof h.ts !== "number" || !Number.isFinite(h.ts)) {
		throw new FrameDecodeError("`ts` doit être un nombre fini");
	}
	if (typeof h.ctr !== "number" || !Number.isInteger(h.ctr) || h.ctr < 0) {
		throw new FrameDecodeError("`ctr` doit être un entier ≥ 0");
	}
	if (
		h.session_nonce !== undefined &&
		(typeof h.session_nonce !== "string" || h.session_nonce.length === 0)
	) {
		throw new FrameDecodeError(
			"`session_nonce` doit être une string non vide si présent"
		);
	}
	return {
		v: PROTOCOL_VERSION,
		dir: h.dir as FrameDir,
		correlation_id: h.correlation_id,
		kind: h.kind as FrameKind,
		ts: h.ts,
		ctr: h.ctr,
		...(typeof h.session_nonce === "string"
			? { session_nonce: h.session_nonce }
			: {})
	};
}

function validatePayload(raw: unknown): Uint8Array {
	if (raw instanceof Uint8Array) return raw;
	if (Buffer.isBuffer(raw)) {
		return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
	}
	throw new FrameDecodeError("`p` (payload) doit être des bytes");
}

function validateSignature(raw: unknown): Uint8Array | null {
	if (raw == null) return null;
	let bytes: Uint8Array;
	if (raw instanceof Uint8Array) {
		bytes = raw;
	} else if (Buffer.isBuffer(raw)) {
		bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
	} else {
		throw new FrameDecodeError("`s` (signature) doit être bytes ou null");
	}
	if (bytes.length !== ED25519_SIG_LEN) {
		throw new FrameDecodeError(
			`signature doit faire ${ED25519_SIG_LEN} bytes (reçu ${bytes.length})`
		);
	}
	return bytes;
}
