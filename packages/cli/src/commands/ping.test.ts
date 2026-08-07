/**
 * Tests unit — command `ping`.
 * Injection totale des fonctions engine — pas d'accès réseau réel.
 */

import { describe, expect, test, vi } from "vitest";
import { ping } from "./ping";

function makeStubs() {
	const pingFn = vi.fn().mockResolvedValue({
		latencyMs: 3,
		source: "env-per-tunnel",
		serverVersion: "16.2"
	});
	const introspectFn = vi.fn().mockResolvedValue({
		engine: "postgres",
		collections: [
			{ name: "users", fields: [], source: "declared" },
			{ name: "orders", fields: [], source: "declared" }
		],
		relations: []
	});
	return { pingFn, introspectFn };
}

describe("ping command", () => {
	test("happy path — retourne latency, source, version, count", async () => {
		const { pingFn, introspectFn } = makeStubs();
		const res = await ping({
			tunnelName: "shop",
			pingFn,
			introspectFn,
			env: { SQLNEST_PG_URL_SHOP: "postgres://a@b/c" }
		});
		expect(res.latencyMs).toBe(3);
		expect(res.source).toBe("env-per-tunnel");
		expect(res.serverVersion).toBe("16.2");
		expect(res.collectionCount).toBe(2);
		expect(pingFn).toHaveBeenCalledWith("shop", expect.anything());
		expect(introspectFn).toHaveBeenCalledWith("shop", expect.anything());
	});

	test("serverVersion optionnel — omis si absent", async () => {
		const pingFn = vi.fn().mockResolvedValue({
			latencyMs: 1,
			source: "env-fallback"
		});
		const introspectFn = vi.fn().mockResolvedValue({
			engine: "postgres",
			collections: [],
			relations: []
		});
		const res = await ping({
			tunnelName: "shop",
			pingFn,
			introspectFn
		});
		expect(res.serverVersion).toBeUndefined();
		expect(res.collectionCount).toBe(0);
	});

	test("propage l'erreur de ping (DSN missing, connexion refuse…)", async () => {
		const pingFn = vi.fn().mockRejectedValue(new Error("connection refused"));
		const introspectFn = vi.fn();
		await expect(
			ping({ tunnelName: "shop", pingFn, introspectFn })
		).rejects.toThrow(/connection refused/);
	});
});
