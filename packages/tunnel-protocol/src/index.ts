/**
 * `@sqlnest/tunnel-protocol` — protocole du tunnel WSS SQLNest.
 *
 * Partagé backend / CLI / frontend. Fournit :
 *   - Framing MessagePack + validation stricte (`codec.ts`).
 *   - Signature Ed25519 détachée (`signature.ts`).
 *   - Anti-replay via counter monotone + skew timestamp (`nonce.ts`).
 *   - ECDH X25519 + HKDF-SHA-256 pour la clé E2E (`ecdh.ts`).
 *   - AEAD ChaCha20-Poly1305 pour le chiffrement browser ↔ CLI
 *     (`aead.ts`).
 *   - Handshake self-signed avec pinning externe (`handshake.ts`).
 */

export {
	decryptPayload,
	encryptPayload
} from "./aead";
export {
	canonicalizeForSigning,
	decodeFrame,
	encodeFrame,
	FrameDecodeError
} from "./codec";
export {
	deriveSharedKey,
	generateX25519Keypair,
	type X25519Keypair
} from "./ecdh";
export {
	decodeHandshakePayload,
	encodeHandshakePayload,
	generateSessionNonce,
	HandshakeDecodeError,
	type HandshakePayload,
	type HandshakeRole,
	SESSION_NONCE_LEN
} from "./handshake";
export {
	type CounterCheckFailure,
	type CounterCheckResult,
	checkAndAdvance,
	createEmitterCounter,
	createPeerCounter,
	type EmitterCounterState,
	nextCounter,
	type PeerCounterState
} from "./nonce";
export { signFrame, verifyFrame } from "./signature";
export {
	CHACHA_NONCE_LEN,
	ED25519_SIG_LEN,
	type Frame,
	type FrameDir,
	type FrameHeader,
	type FrameKind,
	KEY_LEN,
	MAX_SKEW_MS,
	POLY1305_TAG_LEN,
	PROTOCOL_VERSION
} from "./types";
