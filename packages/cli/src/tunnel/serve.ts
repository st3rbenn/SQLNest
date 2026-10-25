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

import { EngineExecutionError } from "@sqlnest/engine";
import { createApiClient } from "../services/api-client";
import { loadOrInitConfig } from "../services/config";
import {
	computeTunnelFingerprint,
	computeTunnelSchemaChecksum,
	detectEngineFromConnectionName
} from "../services/engine";
import { createSchemaCache, dispatchOp } from "./ops";
import type { RemoteOp } from "./ws-client";
import { createTunnelWsClient } from "./ws-client";

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
	| {
			kind: "op-completed";
			op: RemoteOp["op"];
			ok: boolean;
			/** Message court, peuplé UNIQUEMENT quand `ok === false` — remonte
			 *  la cause de l'échec (ex: "connect ECONNREFUSED 127.0.0.1:5432"
			 *  quand Postgres est down) pour que le CLI puisse l'afficher au
			 *  user au lieu d'un opaque « ✗ ». */
			error?: string;
	  }
	| { kind: "error"; message: string };

/**
 * Démarre le tunnel et bloque jusqu'à SIGINT/SIGTERM. Retourne 0 à
 * l'arrêt propre — le code de sortie de `sqlnest connect`.
 */
export async function serveTunnel(opts: ServeTunnelOptions): Promise<number> {
	// Récupère la keypair Ed25519 du CLI (déjà générée par le device flow
	// ou CI mode via `loadOrInitConfig` juste avant).
	const { config, privateKeyHex } = loadOrInitConfig();
	const cliEd25519Public = hexToBytes(config.keypair.public);
	const cliEd25519Private = hexToBytes(privateKeyHex);

	const baseWsUrl = opts.baseUrl.replace(HTTP_PREFIX_RE, "ws$1://");

	opts.onEvent?.({ kind: "connecting" });

	// Heartbeat au boot du serve loop — envoie fingerprint DB + schema
	// checksum au backend même quand `findResumableTunnel` a skip
	// l'authenticate. Best-effort : silencieux si offline ou DSN down, le
	// backend backfill au prochain heartbeat qui réussit. Fire-and-forget
	// pour ne pas bloquer le serve.
	sendBootHeartbeat(opts).catch((err) => {
		if (process.env.NODE_ENV === "development") {
			const msg = err instanceof Error ? err.message : String(err);
			process.stderr.write(`[sqlnest dev] heartbeat FAILED: ${msg}\n`);
		}
		// prod : silencieux — la connectivité DSN est validée séparément et
		// l'absence de fingerprint côté serveur n'empêche pas le serve loop.
	});

	const schema = createSchemaCache();
	const client = createTunnelWsClient({
		baseWsUrl,
		sessionId: opts.sessionId,
		token: opts.token,
		cliEd25519Private,
		cliEd25519Public,
		async runOp(op) {
			opts.onEvent?.({ kind: "op-received", op: op.op });
			try {
				const result = await dispatchOp(op, {
					connectionName: opts.connectionName,
					env: opts.env ?? process.env,
					schema
				});
				opts.onEvent?.({
					kind: "op-completed",
					op: op.op,
					ok: result.ok,
					...(result.ok ? {} : { error: result.error })
				});
				return result;
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				// Détail structuré Postgres — remonté au frontend pour permettre
				// `$N → span source SNQL`. Absent quand la cause n'est pas une
				// erreur pg (connect timeout, config, etc.).
				const pgError =
					err instanceof EngineExecutionError ? err.pgError : undefined;
				opts.onEvent?.({
					kind: "op-completed",
					op: op.op,
					ok: false,
					error: message
				});
				return pgError !== undefined
					? { ok: false, error: message, pgError }
					: { ok: false, error: message };
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
 * Envoie le heartbeat au backend avec le fingerprint DB + le schema
 * checksum. Best-effort — fire-and-forget dans le serve. Calcul parallèle
 * des 2 métadonnées pour minimiser le temps de boot. Log stderr en dev
 * uniquement pour tracer le flow sans polluer la prod.
 */
async function sendBootHeartbeat(opts: ServeTunnelOptions): Promise<void> {
	const [dbFingerprint, dbSchemaChecksum] = await Promise.all([
		computeTunnelFingerprint(opts.connectionName, opts.env),
		computeTunnelSchemaChecksum(opts.connectionName, opts.env)
	]);
	// Engine détecté (scheme DSN) envoyé au heartbeat pour backfill
	// db_connection.engine côté backend (pairing historique stocke
	// DEFAULT_ENGINE="postgres" en dur, ne distingue pas Mongo).
	const engine = detectEngineFromConnectionName(opts.connectionName, opts.env);
	if (process.env.NODE_ENV === "development") {
		process.stderr.write(
			`[sqlnest dev] heartbeat dbFingerprint=${JSON.stringify(dbFingerprint)} dbSchemaChecksum=${JSON.stringify(dbSchemaChecksum)} engine=${JSON.stringify(engine)}\n`
		);
	}
	// Skip l'appel si aucune info neuve à backfill (les 3 nulls simultanés
	// = pas la peine de tirer sur le rate-limit backend).
	if (dbFingerprint === null && dbSchemaChecksum === null && engine === null)
		return;
	const api = createApiClient(opts.baseUrl);
	await api.heartbeat(opts.token, dbFingerprint, dbSchemaChecksum, engine);
}

function hexToBytes(hex: string): Uint8Array {
	const out = new Uint8Array(hex.length / 2);
	for (let i = 0; i < out.length; i++) {
		out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	}
	return out;
}
