/**
 * Tests unit — TunnelRegistry (routing in-memory, single-active CLI,
 * multi-browsers, cleanup slot vide).
 */

import { describe, expect, test, vi } from "vitest";
import {
	createTunnelRegistry,
	type RegistrySocket,
	WS_CLOSE_REPLACED
} from "./registry";

function makeSocket(id: string): RegistrySocket & {
	sent: Uint8Array[];
	closed: Array<{ code?: number; reason?: string }>;
} {
	const sent: Uint8Array[] = [];
	const closed: Array<{ code?: number; reason?: string }> = [];
	return {
		id,
		send: vi.fn((bytes: Uint8Array) => {
			sent.push(bytes);
		}),
		close: vi.fn((code?: number, reason?: string) => {
			closed.push({
				...(code !== undefined ? { code } : {}),
				...(reason !== undefined ? { reason } : {})
			});
		}),
		sent,
		closed
	};
}

const TUNNEL_ID = "tunnel-1";
const USER_ID = "user-alice";
const CONN_ID = "conn-1";
const FINGERPRINT = "a".repeat(64);

describe("attachCli", () => {
	test("crée le slot au 1er attach", () => {
		const reg = createTunnelRegistry();
		reg.attachCli({
			tunnelId: TUNNEL_ID,
			userId: USER_ID,
			connectionId: CONN_ID,
			cliFingerprint: FINGERPRINT,
			socket: makeSocket("s1")
		});
		expect(reg.size()).toBe(1);
		expect(reg.getSlot(TUNNEL_ID)?.userId).toBe(USER_ID);
	});

	test("nouveau CLI socket ferme l'ancien avec WS_CLOSE_REPLACED", () => {
		const reg = createTunnelRegistry();
		const oldSock = makeSocket("s1");
		reg.attachCli({
			tunnelId: TUNNEL_ID,
			userId: USER_ID,
			connectionId: CONN_ID,
			cliFingerprint: FINGERPRINT,
			socket: oldSock
		});
		const newSock = makeSocket("s2");
		reg.attachCli({
			tunnelId: TUNNEL_ID,
			userId: USER_ID,
			connectionId: CONN_ID,
			cliFingerprint: FINGERPRINT,
			socket: newSock
		});
		expect(oldSock.closed[0]?.code).toBe(WS_CLOSE_REPLACED);
		expect(reg.getSlot(TUNNEL_ID)?.cli?.id).toBe("s2");
	});
});

describe("detachCli", () => {
	test("retire le CLI, garde le slot si browser présent", () => {
		const reg = createTunnelRegistry();
		reg.attachCli({
			tunnelId: TUNNEL_ID,
			userId: USER_ID,
			connectionId: CONN_ID,
			cliFingerprint: FINGERPRINT,
			socket: makeSocket("cli")
		});
		reg.attachBrowser(TUNNEL_ID, USER_ID, makeSocket("browser"));
		reg.detachCli(TUNNEL_ID, "cli");
		expect(reg.size()).toBe(1);
		expect(reg.getSlot(TUNNEL_ID)?.cli).toBeNull();
	});

	test("supprime le slot si complètement vide après détach", () => {
		const reg = createTunnelRegistry();
		reg.attachCli({
			tunnelId: TUNNEL_ID,
			userId: USER_ID,
			connectionId: CONN_ID,
			cliFingerprint: FINGERPRINT,
			socket: makeSocket("cli")
		});
		reg.detachCli(TUNNEL_ID, "cli");
		expect(reg.size()).toBe(0);
	});

	test("détach d'un socket ID inconnu → no-op", () => {
		const reg = createTunnelRegistry();
		reg.attachCli({
			tunnelId: TUNNEL_ID,
			userId: USER_ID,
			connectionId: CONN_ID,
			cliFingerprint: FINGERPRINT,
			socket: makeSocket("cli")
		});
		reg.detachCli(TUNNEL_ID, "different-id");
		expect(reg.getSlot(TUNNEL_ID)?.cli?.id).toBe("cli");
	});
});

describe("attachBrowser", () => {
	test("tunnel_not_found si CLI jamais attaché", () => {
		const reg = createTunnelRegistry();
		const res = reg.attachBrowser(TUNNEL_ID, USER_ID, makeSocket("b1"));
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.reason).toBe("tunnel_not_found");
	});

	test("user_mismatch si browser userId ≠ slot userId", () => {
		const reg = createTunnelRegistry();
		reg.attachCli({
			tunnelId: TUNNEL_ID,
			userId: USER_ID,
			connectionId: CONN_ID,
			cliFingerprint: FINGERPRINT,
			socket: makeSocket("cli")
		});
		const res = reg.attachBrowser(TUNNEL_ID, "user-mallory", makeSocket("b"));
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.reason).toBe("user_mismatch");
	});

	test("plusieurs browsers du même user → tous attachés", () => {
		const reg = createTunnelRegistry();
		reg.attachCli({
			tunnelId: TUNNEL_ID,
			userId: USER_ID,
			connectionId: CONN_ID,
			cliFingerprint: FINGERPRINT,
			socket: makeSocket("cli")
		});
		expect(reg.attachBrowser(TUNNEL_ID, USER_ID, makeSocket("b1")).ok).toBe(
			true
		);
		expect(reg.attachBrowser(TUNNEL_ID, USER_ID, makeSocket("b2")).ok).toBe(
			true
		);
		expect(reg.getSlot(TUNNEL_ID)?.browsers.size).toBe(2);
	});
});

describe("routeToCliFromBrowser", () => {
	test("send au CLI + retourne true", () => {
		const reg = createTunnelRegistry();
		const cli = makeSocket("cli");
		reg.attachCli({
			tunnelId: TUNNEL_ID,
			userId: USER_ID,
			connectionId: CONN_ID,
			cliFingerprint: FINGERPRINT,
			socket: cli
		});
		const bytes = new Uint8Array([1, 2, 3]);
		expect(reg.routeToCliFromBrowser(TUNNEL_ID, bytes)).toBe(true);
		expect(cli.sent).toEqual([bytes]);
	});

	test("false si tunnel inconnu", () => {
		const reg = createTunnelRegistry();
		expect(reg.routeToCliFromBrowser("nope", new Uint8Array([0]))).toBe(false);
	});

	test("false si CLI détaché", () => {
		const reg = createTunnelRegistry();
		reg.attachCli({
			tunnelId: TUNNEL_ID,
			userId: USER_ID,
			connectionId: CONN_ID,
			cliFingerprint: FINGERPRINT,
			socket: makeSocket("cli")
		});
		reg.attachBrowser(TUNNEL_ID, USER_ID, makeSocket("b"));
		reg.detachCli(TUNNEL_ID, "cli");
		expect(reg.routeToCliFromBrowser(TUNNEL_ID, new Uint8Array([0]))).toBe(
			false
		);
	});
});

describe("routeToBrowsersFromCli", () => {
	test("broadcast à tous les browsers du tunnel + retourne le count", () => {
		const reg = createTunnelRegistry();
		reg.attachCli({
			tunnelId: TUNNEL_ID,
			userId: USER_ID,
			connectionId: CONN_ID,
			cliFingerprint: FINGERPRINT,
			socket: makeSocket("cli")
		});
		const b1 = makeSocket("b1");
		const b2 = makeSocket("b2");
		reg.attachBrowser(TUNNEL_ID, USER_ID, b1);
		reg.attachBrowser(TUNNEL_ID, USER_ID, b2);
		const bytes = new Uint8Array([42]);
		const n = reg.routeToBrowsersFromCli(TUNNEL_ID, bytes);
		expect(n).toBe(2);
		expect(b1.sent).toEqual([bytes]);
		expect(b2.sent).toEqual([bytes]);
	});

	test("0 si aucun browser attaché", () => {
		const reg = createTunnelRegistry();
		reg.attachCli({
			tunnelId: TUNNEL_ID,
			userId: USER_ID,
			connectionId: CONN_ID,
			cliFingerprint: FINGERPRINT,
			socket: makeSocket("cli")
		});
		expect(reg.routeToBrowsersFromCli(TUNNEL_ID, new Uint8Array())).toBe(0);
	});
});

describe("cleanup slot vide", () => {
	test("détach du dernier browser + pas de CLI → slot supprimé", () => {
		const reg = createTunnelRegistry();
		reg.attachCli({
			tunnelId: TUNNEL_ID,
			userId: USER_ID,
			connectionId: CONN_ID,
			cliFingerprint: FINGERPRINT,
			socket: makeSocket("cli")
		});
		reg.attachBrowser(TUNNEL_ID, USER_ID, makeSocket("b"));
		reg.detachCli(TUNNEL_ID, "cli");
		expect(reg.size()).toBe(1);
		reg.detachBrowser(TUNNEL_ID, "b");
		expect(reg.size()).toBe(0);
	});
});
