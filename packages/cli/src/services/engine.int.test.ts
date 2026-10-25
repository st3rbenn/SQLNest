/**
 * Tests d'intégration réels — engine CLI ↔ Postgres.
 *
 * Se connecte au container `sqlnest-postgres` (port 5433, DB
 * `sqlnest_shop` — dataset e-commerce du monorepo). Skip proprement si
 * le container n'est pas disponible (CI sans docker par ex.).
 *
 * Réutilise `resolveLocalConnectionUrl` — le test set `SQLNEST_PG_URL_SHOP`
 * via env. Aucun accès à `~/.sqlnest/local-connections.toml` réel n'est
 * fait (config dir override via `SQLNEST_CONFIG_DIR`).
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test
} from "vitest";
import {
	introspectTunnel,
	openConnectionForTunnel,
	pingTunnel,
	runSnqlOnTunnel
} from "./engine";

const TEST_PG_URL =
	process.env.SQLNEST_TEST_PG_URL ??
	"postgres://sqlnest:sqlnest@localhost:5433/sqlnest_shop";

// ─── Docker probe TOP-LEVEL AWAIT ────────────────────────────────────
// Évalué au chargement du module — avant les `describe.skipIf`. Sans ça,
// `dockerAvailable` serait encore `false` à l'évaluation du skipIf
// (beforeAll runt trop tard). Node ESM + Vitest supportent le TLA.
const probeDir = mkdtempSync(join(tmpdir(), "sqlnest-engine-probe-"));
process.env.SQLNEST_CONFIG_DIR = probeDir;
process.env.SQLNEST_PG_URL_SHOP = TEST_PG_URL;

const dockerAvailable = await (async () => {
	try {
		const conn = await openConnectionForTunnel("shop");
		await conn.ping();
		await conn.close();
		return true;
	} catch {
		return false;
	}
})();

if (existsSync(probeDir)) rmSync(probeDir, { recursive: true, force: true });

let tempDir: string;

beforeAll(() => {
	tempDir = mkdtempSync(join(tmpdir(), "sqlnest-engine-int-"));
	process.env.SQLNEST_CONFIG_DIR = tempDir;
	process.env.SQLNEST_PG_URL_SHOP = TEST_PG_URL;
});

afterAll(() => {
	delete process.env.SQLNEST_CONFIG_DIR;
	delete process.env.SQLNEST_PG_URL_SHOP;
	if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
	process.env.SQLNEST_CONFIG_DIR = tempDir;
	process.env.SQLNEST_PG_URL_SHOP = TEST_PG_URL;
});

describe.skipIf(!dockerAvailable)(
	"engine CLI — intégration réelle Postgres",
	() => {
		test('pingTunnel("shop") — latency + source', async () => {
			const res = await pingTunnel("shop");
			expect(res.latencyMs).toBeGreaterThanOrEqual(0);
			expect(res.latencyMs).toBeLessThan(5_000);
			expect(res.source).toBe("env-per-tunnel");
		});

		test('introspectTunnel("shop") — collections attendues du dataset', async () => {
			const schema = await introspectTunnel("shop");
			expect(schema.engine).toBe("postgres");
			const names = new Set(schema.collections.map((c) => c.name));
			// Le seed shop crée au minimum `users`, `orders`, `products`.
			expect(names.has("users")).toBe(true);
			expect(names.has("orders")).toBe(true);
			expect(names.has("products")).toBe(true);
		});

		test('runSnqlOnTunnel("shop", ...) — SNQL simple retourne des rows', async () => {
			const result = await runSnqlOnTunnel(
				"shop",
				"get users pick id limit 3"
			);
			expect(result.written).toBe(false);
			expect(result.rows.length).toBeGreaterThan(0);
			expect(result.rows.length).toBeLessThanOrEqual(3);
			// La colonne `id` est sélectionnée.
			expect(result.columns.some((c) => c.name === "id")).toBe(true);
		});

		test("règle 2 sécu ancrée — la DSN n'apparaît nulle part dans les résultats", async () => {
			const secret = TEST_PG_URL;
			const ping = await pingTunnel("shop");
			const introspect = await introspectTunnel("shop");
			const query = await runSnqlOnTunnel(
				"shop",
				"get users pick id limit 1"
			);
			for (const obj of [ping, introspect, query]) {
				const raw = JSON.stringify(obj);
				// La DSN complète (avec creds) ne doit apparaître dans aucun
				// output — un caller qui logue ces objets ne peut pas fuiter
				// les creds.
				expect(raw).not.toContain(secret);
				expect(raw).not.toContain("sqlnest:sqlnest");
			}
		});
	}
);
