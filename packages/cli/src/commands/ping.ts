/**
 * `sqlnest ping --tunnel <name>` — diagnostic local d'une DSN Postgres.
 *
 * ─── But ──────────────────────────────────────────────────────────────
 * Vérifier que la DSN configurée pour un tunnel donné :
 *   - est résolvable (env per-tunnel > env fallback > local-file),
 *   - accepte la connexion (auth OK, réseau OK),
 *   - retourne un ping avec latence + version PG.
 *
 * Utile AVANT que le WS backend soit établi — l'user peut vérifier que sa
 * configuration locale marche sans avoir à naviguer le flow complet du
 * device pairing.
 *
 * ─── Sécurité ─────────────────────────────────────────────────────────
 * L'output ne contient JAMAIS la DSN — uniquement `source`
 * (`env-per-tunnel` / `env-fallback` / `local-file` / `env-file`), latence, et
 * `serverVersion` (renvoyée par PG lui-même — pas un secret).
 */

import { defineCommand, parseCommandArgs } from "../app/command";
import {
	introspectTunnel as defaultIntrospect,
	pingTunnel as defaultPing,
	type TunnelPingResult
} from "../services/engine";
import { LocalConnectionNotFoundError } from "../services/local-connections";

export interface PingCommandOptions {
	readonly tunnelName: string;
	readonly env?: NodeJS.ProcessEnv;
	// Injection pour test.
	readonly pingFn?: typeof defaultPing;
	readonly introspectFn?: typeof defaultIntrospect;
}

export interface PingCommandResult {
	readonly latencyMs: number;
	readonly source: TunnelPingResult["source"];
	readonly serverVersion?: string;
	/** Nombre de collections détectées à l'introspection. Un chiffre nul
	 *  signale une base vide ou un search_path mal configuré (souvent utile
	 *  en dev). */
	readonly collectionCount: number;
}

export async function ping(
	opts: PingCommandOptions
): Promise<PingCommandResult> {
	const env = opts.env ?? process.env;
	const pingFn = opts.pingFn ?? defaultPing;
	const introspectFn = opts.introspectFn ?? defaultIntrospect;

	const pingRes = await pingFn(opts.tunnelName, env);
	// Introspection légère — surface un feedback utile si la base est vide
	// ou que le schéma cible n'a pas de tables. On garde ça dans la même
	// commande pour éviter à l'user de lancer 2 commandes.
	const schema = await introspectFn(opts.tunnelName, env);

	return {
		latencyMs: pingRes.latencyMs,
		source: pingRes.source,
		...(pingRes.serverVersion !== undefined
			? { serverVersion: pingRes.serverVersion }
			: {}),
		collectionCount: schema.collections.length
	};
}

export const pingCommand = defineCommand({
	name: "ping",
	help: [["sqlnest ping --tunnel <name>", "Ping local DSN (diagnostic)"]],
	async run(args, ctx) {
		const values = parseCommandArgs(ctx, "ping", args, {
			tunnel: { type: "string" }
		});
		if (values === undefined) return 2;
		const tunnelName = values.tunnel;
		if (!tunnelName) {
			ctx.stderr(
				"sqlnest ping: `--tunnel <name>` est requis. Ex: sqlnest ping --tunnel prod"
			);
			return 2;
		}
		try {
			const res = await ctx.services.ping({
				tunnelName,
				...(ctx.env ? { env: ctx.env } : {})
			});
			ctx.stdout(
				`✓ Ping OK — ${res.latencyMs} ms (source: ${res.source})${
					res.serverVersion ? ` — PG ${res.serverVersion}` : ""
				}`
			);
			ctx.stdout(
				`  ${res.collectionCount} collections détectées à l'introspection`
			);
			return 0;
		} catch (err) {
			if (err instanceof LocalConnectionNotFoundError) {
				ctx.stderr(`✗ ${err.message}`);
				return 1;
			}
			ctx.stderr(`✗ Ping échec : ${(err as Error).message ?? String(err)}`);
			return 1;
		}
	}
});
