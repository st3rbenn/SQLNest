/**
 * `serveTunnel` — après un pairing réussi (device flow ou CI), ouvre le
 * WS `/api/tunnels/:sessionId/cli` et bloque jusqu'à SIGINT/SIGTERM.
 *
 * Le CLI joue le rôle de "worker" : il reçoit les frames `req` du
 * backend-proxy (ou d'un browser) via le tunnel, dispatch vers le moteur
 * local (`@sqlnest/engine`) branché sur la DSN de `connectionName`, et
 * répond via une frame `res`.
 *
 * ─── Contrat ──────────────────────────────────────────────────────────
 * Tant que le process CLI vit, le tunnel est "actif" côté backend. Une
 * fermeture propre (Ctrl-C) déclenche `cli.stop()` + le WS backend
 * détecte la déconnexion et purge le slot du registry.
 */

import type { RemoteOp, RemoteResult } from "../ws-client";
import { createTunnelWsClient } from "../ws-client";
import { loadOrInitConfig } from "./connect";
import { runQuery } from "@sqlnest/engine";
import { openConnectionForTunnel } from "../engine";

const HTTP_PREFIX_RE = /^http(s?):\/\//;

export interface ServeTunnelOptions {
	readonly baseUrl: string;
	readonly sessionId: string;
	/** Token clair `tn_...` obtenu à `/authenticate`. */
	readonly token: string;
	/** Nom local de la connection — sert à résoudre la DSN via
	 *  `resolveLocalConnectionUrl` (env `SQLNEST_PG_URL_<UPPER>` ou
	 *  `~/.sqlnest/local-connections.toml`). */
	readonly connectionName: string;
	/** Env pour la résolution DSN (défaut process.env). */
	readonly env?: NodeJS.ProcessEnv;
	/** Callback statut — utile pour l'UI CLI (spinner, logs). */
	readonly onEvent?: (event: ServeEvent) => void;
}

export type ServeEvent =
	| { kind: "connecting" }
	| { kind: "op-received"; op: RemoteOp["op"] }
	| { kind: "op-completed"; op: RemoteOp["op"]; ok: boolean }
	| { kind: "error"; message: string };

/**
 * Démarre le tunnel et bloque jusqu'à SIGINT/SIGTERM. Retourne 0 à
 * l'arrêt propre. Le caller (cli.ts) fait `process.exit(await serveTunnel(...))`.
 */
export async function serveTunnel(opts: ServeTunnelOptions): Promise<number> {
	// Récupère la keypair Ed25519 du CLI (déjà générée par le device flow
	// ou CI mode via `loadOrInitConfig` juste avant).
	const { config, privateKeyHex } = loadOrInitConfig();
	const cliEd25519Public = hexToBytes(config.keypair.public);
	const cliEd25519Private = hexToBytes(privateKeyHex);

	const baseWsUrl = opts.baseUrl.replace(HTTP_PREFIX_RE, "ws$1://");

	opts.onEvent?.({ kind: "connecting" });

	const client = createTunnelWsClient({
		baseWsUrl,
		sessionId: opts.sessionId,
		token: opts.token,
		cliEd25519Private,
		cliEd25519Public,
		async runOp(op) {
			opts.onEvent?.({ kind: "op-received", op: op.op });
			try {
				const result = await dispatchOp(op, opts.connectionName, opts.env);
				opts.onEvent?.({
					kind: "op-completed",
					op: op.op,
					ok: result.ok
				});
				return result;
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				opts.onEvent?.({
					kind: "op-completed",
					op: op.op,
					ok: false
				});
				return { ok: false, error: message };
			}
		},
		onError: (err) => {
			const message = err instanceof Error ? err.message : String(err);
			opts.onEvent?.({ kind: "error", message });
		}
	});

	client.start();

	// Blocage : promise qui résout sur SIGINT/SIGTERM. Le process ne
	// termine pas tant qu'aucun de ces signaux n'arrive.
	await new Promise<void>((resolve) => {
		const shutdown = (): void => {
			resolve();
		};
		process.once("SIGINT", shutdown);
		process.once("SIGTERM", shutdown);
	});

	await client.stop();
	// Laisse un beat au WS pour flush le close côté serveur.
	await new Promise((r) => setTimeout(r, 100));
	return 0;
}

/**
 * Dispatch d'une op reçue du tunnel vers le moteur local Postgres.
 * Chaque op ouvre + ferme sa propre connexion (pas de pool partagé pour
 * le moment — un pool serait un ajout de v1.1 si le throughput l'exige).
 */
async function dispatchOp(
	op: RemoteOp,
	connectionName: string,
	env?: NodeJS.ProcessEnv
): Promise<RemoteResult> {
	if (op.op === "ping") {
		const conn = await openConnectionForTunnel(connectionName, env ?? process.env);
		try {
			const ping = await conn.ping();
			return { ok: true, data: ping };
		} finally {
			await conn.close();
		}
	}
	if (op.op === "introspect") {
		const conn = await openConnectionForTunnel(connectionName, env ?? process.env);
		try {
			const schema = await conn.introspect();
			return { ok: true, data: schema };
		} finally {
			await conn.close();
		}
	}
	if (op.op === "runSnql") {
		const conn = await openConnectionForTunnel(connectionName, env ?? process.env);
		try {
			const rs = await runQuery(conn, op.src);
			return {
				ok: true,
				data: {
					columns: rs.columns,
					rows: rs.rows,
					rowCount: rs.rowCount,
					written: rs.written
				}
			};
		} finally {
			await conn.close();
		}
	}
	return { ok: false, error: `op inconnue` };
}

function hexToBytes(hex: string): Uint8Array {
	const out = new Uint8Array(hex.length / 2);
	for (let i = 0; i < out.length; i++) {
		out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	}
	return out;
}
