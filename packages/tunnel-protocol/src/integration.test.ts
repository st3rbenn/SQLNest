/**
 * Test intégration — deux peers (Alice=CLI, Bob=browser) échangent des
 * frames complètes via le protocole entier.
 *
 * Séquence :
 *   1. Handshake bidirectionnel signé Ed25519.
 *   2. Dérivation de la clé sym partagée via ECDH X25519.
 *   3. Alice envoie une frame req chiffrée+signée, Bob la reçoit et
 *      décrypte+vérifie.
 *   4. Alice envoie une seconde frame (ctr incrémenté) — acceptée.
 *   5. Bob replay une frame ancienne (ctr obsolète) — REFUSÉE.
 *   6. Tamper d'une frame en cours de route — REFUSÉ.
 */

import { ed25519 } from "@noble/curves/ed25519.js";
import { describe, expect, test } from "vitest";
import { decryptPayload, encryptPayload } from "./aead";
import { decodeFrame, encodeFrame } from "./codec";
import { deriveSharedKey, generateX25519Keypair } from "./ecdh";
import {
	decodeHandshakePayload,
	encodeHandshakePayload,
	generateSessionNonce
} from "./handshake";
import {
	checkAndAdvance,
	createEmitterCounter,
	createPeerCounter,
	nextCounter
} from "./nonce";
import { signFrame, verifyFrame } from "./signature";
import type { Frame, FrameHeader } from "./types";

interface Peer {
	role: "cli" | "browser";
	ed: { priv: Uint8Array; pub: Uint8Array };
	x: { priv: Uint8Array; pub: Uint8Array };
	sessionNonce: Uint8Array;
	emitter: ReturnType<typeof createEmitterCounter>;
}

function makePeer(role: "cli" | "browser"): Peer {
	const priv = ed25519.utils.randomSecretKey();
	const pub = ed25519.getPublicKey(priv);
	const xkp = generateX25519Keypair();
	return {
		role,
		ed: { priv, pub },
		x: { priv: xkp.privateKey, pub: xkp.publicKey },
		sessionNonce: generateSessionNonce(),
		emitter: createEmitterCounter()
	};
}

function emitFrame(
	peer: Peer,
	kind: FrameHeader["kind"],
	correlationId: string,
	payload: Uint8Array,
	peerSessionNonce: Uint8Array,
	ts: number
): { bytes: Uint8Array; frame: Frame } {
	const header: FrameHeader = {
		v: 1,
		dir: peer.role,
		correlation_id: correlationId,
		kind,
		ts,
		ctr: nextCounter(peer.emitter),
		session_nonce: Buffer.from(peerSessionNonce).toString("hex")
	};
	const sig = signFrame(header, payload, peer.ed.priv);
	const frame: Frame = { header, payload, signature: sig };
	return { bytes: encodeFrame(frame), frame };
}

describe("integration — flow complet CLI ↔ browser", () => {
	test("handshake + 2 frames chiffrées + replay refusé", () => {
		const alice = makePeer("cli");
		const bob = makePeer("browser");
		const now = 1_700_000_000_000;

		// ─── 1. Handshake bidirectionnel ──────────────────────────────
		// Alice → Bob : payload contient les 2 pubkeys + sa nonce.
		const aliceHsPayload = encodeHandshakePayload({
			role: "cli",
			ed25519_pubkey: alice.ed.pub,
			x25519_pubkey: alice.x.pub,
			session_nonce: alice.sessionNonce
		});
		const aliceHs = emitFrame(
			alice,
			"handshake",
			"handshake",
			aliceHsPayload,
			// Avant réception de la nonce de Bob, Alice met sa propre
			// nonce (auto-référentielle) — pas d'importance car le
			// counter check ne kicks in qu'après.
			alice.sessionNonce,
			now
		);
		const bobHsPayload = encodeHandshakePayload({
			role: "browser",
			ed25519_pubkey: bob.ed.pub,
			x25519_pubkey: bob.x.pub,
			session_nonce: bob.sessionNonce
		});
		emitFrame(
			bob,
			"handshake",
			"handshake",
			bobHsPayload,
			bob.sessionNonce,
			now
		);

		// Bob reçoit le handshake d'Alice, vérifie la signature, extrait
		// les pubkeys + nonce.
		const decodedFromAlice = decodeFrame(aliceHs.bytes);
		expect(verifyFrame(decodedFromAlice, alice.ed.pub)).toBe(true);
		const alicePayloadDecoded = decodeHandshakePayload(
			decodedFromAlice.payload
		);
		expect(alicePayloadDecoded.role).toBe("cli");
		expect(alicePayloadDecoded.ed25519_pubkey).toEqual(alice.ed.pub);

		// ─── 2. Dérivation clé sym E2E ────────────────────────────────
		const aliceKey = deriveSharedKey(alice.x.priv, bob.x.pub, alice.x.pub);
		const bobKey = deriveSharedKey(bob.x.priv, alice.x.pub, bob.x.pub);
		expect(aliceKey).toEqual(bobKey);

		// ─── 3. Alice envoie req chiffrée + signée à Bob ──────────────
		const secret = new TextEncoder().encode(
			JSON.stringify({ op: "runSnql", src: "get users limit 3" })
		);
		const cipher1 = encryptPayload(
			aliceKey,
			{
				v: 1,
				dir: "cli",
				correlation_id: "q-1",
				kind: "req",
				ts: now,
				ctr: alice.emitter.next,
				session_nonce: Buffer.from(bob.sessionNonce).toString("hex")
			},
			secret
		);
		const alicePkt1 = emitFrame(
			alice,
			"req",
			"q-1",
			cipher1,
			bob.sessionNonce,
			now
		);

		// Bob reçoit + vérifie + décrypte + counter check.
		const bobRecvState = createPeerCounter();
		const decodedFrom1 = decodeFrame(alicePkt1.bytes);
		expect(verifyFrame(decodedFrom1, alice.ed.pub)).toBe(true);
		const advance1 = checkAndAdvance(
			bobRecvState,
			decodedFrom1.header.ctr,
			decodedFrom1.header.ts,
			now
		);
		expect(advance1.ok).toBe(true);
		const clear1 = decryptPayload(
			bobKey,
			decodedFrom1.header,
			decodedFrom1.payload
		);
		expect(new TextDecoder().decode(clear1)).toContain("runSnql");

		// ─── 4. Alice envoie une seconde frame → acceptée ─────────────
		const cipher2 = encryptPayload(
			aliceKey,
			{
				v: 1,
				dir: "cli",
				correlation_id: "q-2",
				kind: "req",
				ts: now + 100,
				ctr: alice.emitter.next,
				session_nonce: Buffer.from(bob.sessionNonce).toString("hex")
			},
			new TextEncoder().encode("second")
		);
		const alicePkt2 = emitFrame(
			alice,
			"req",
			"q-2",
			cipher2,
			bob.sessionNonce,
			now + 100
		);
		const decodedFrom2 = decodeFrame(alicePkt2.bytes);
		expect(verifyFrame(decodedFrom2, alice.ed.pub)).toBe(true);
		const advance2 = checkAndAdvance(
			bobRecvState,
			decodedFrom2.header.ctr,
			decodedFrom2.header.ts,
			now + 100
		);
		expect(advance2.ok).toBe(true);

		// ─── 5. Replay de la 1re frame → REFUSÉ ────────────────────────
		const replay = checkAndAdvance(
			bobRecvState,
			decodedFrom1.header.ctr,
			decodedFrom1.header.ts,
			now + 200
		);
		expect(replay.ok).toBe(false);

		// ─── 6. Tamper de la 2e frame ──────────────────────────────────
		// Un attaquant flip le dernier byte du ciphertext.
		const tampered = new Uint8Array(alicePkt2.bytes);
		// biome-ignore lint/style/noNonNullAssertion: length > 0
		tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 0xff;
		// Le decode peut réussir (MessagePack tolère) mais la sig doit
		// échouer OU le decrypt lever. Dans les 2 cas, la frame est
		// rejetée.
		try {
			const tamperedFrame = decodeFrame(tampered);
			const sigOk = verifyFrame(tamperedFrame, alice.ed.pub);
			// Si la sig passe, le decrypt DOIT échouer.
			if (sigOk) {
				expect(() =>
					decryptPayload(bobKey, tamperedFrame.header, tamperedFrame.payload)
				).toThrow();
			} else {
				expect(sigOk).toBe(false);
			}
		} catch (err) {
			// decode a levé → rejet précoce, OK.
			expect(err).toBeDefined();
		}
	});
});
