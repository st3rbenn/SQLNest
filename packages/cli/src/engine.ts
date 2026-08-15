/**
 * Wrapper CLI sur `@sqlnest/engine` — ouvre une connexion Postgres locale
 * pour un tunnel donné, ping, introspection, exécution SNQL.
 *
 * ─── Rôle ─────────────────────────────────────────────────────────────
 * Ce module est le seul point du CLI qui manipule la DSN Postgres. Toute
 * autre partie (WS handler Bloc 7, commandes user) reçoit un `Connection`
 * déjà ouvert et n'accède JAMAIS à la string de connexion — protection
 * contre la fuite accidentelle dans un log/frame WS.
 *
 * ─── Réutilise l'engine du backend ─────────────────────────────────────
 * `@sqlnest/engine` expose `connect()`, `runQuery()` (SNQL → SQL Postgres
 * → exécution), et le driver `postgres.js` sous-jacent. Le CLI est un
 * miroir de la logique côté serveur du Bloc 8 — même code path,
 * simplement exécuté sur la machine du user avec ses creds.
 */

import {
	type Connection,
	connect as engineConnect,
	type PingResult,
	type ResolvedEngineConfig,
	resolveMongoConfig,
	type ResultSet,
	resolvePostgresConfig,
	runQuery,
	type SchemaModel
} from "@sqlnest/engine";
import {
	describeConnectionForDiagnostics,
	resolveLocalConnectionUrl
} from "./local-connections";

/** Résultat d'un `pingTunnel` — enrichi avec les infos SAFE de source
 * DSN (env-per-tunnel / env-fallback / local-file). */
export interface TunnelPingResult extends PingResult {
	readonly source: "env-per-tunnel" | "env-fallback" | "local-file";
}

/**
 * Ouvre une connexion Postgres locale pour le tunnel demandé. Résout la
 * DSN via `resolveLocalConnectionUrl` puis délègue à `@sqlnest/engine`.
 *
 * Le caller DOIT `close()` la connexion en fin de vie.
 */
export async function openConnectionForTunnel(
	tunnelName: string,
	env: NodeJS.ProcessEnv = process.env
): Promise<Connection> {
	const url = resolveLocalConnectionUrl(tunnelName, env);
	return engineConnect(resolveEngineConfigFromUrl(url));
}

/**
 * Détecte l'engine cible depuis le scheme de la DSN et route vers le bon
 * resolver. Support v1 : postgres/postgresql → PG, mongodb/mongodb+srv →
 * Mongo. Tout autre scheme = engine non supporté (message clair).
 */
function resolveEngineConfigFromUrl(url: string): ResolvedEngineConfig {
	// Parse le scheme sans exposer la DSN complète en erreur (aucun log de
	// l'URL). Le colon `:` termine le scheme dans une URL standard.
	const colonIdx = url.indexOf(":");
	const scheme = colonIdx > 0 ? url.slice(0, colonIdx).toLowerCase() : "";
	if (scheme === "postgres" || scheme === "postgresql") {
		return resolvePostgresConfig({ url });
	}
	if (scheme === "mongodb" || scheme === "mongodb+srv") {
		return resolveMongoConfig({ url });
	}
	throw new Error(
		`Scheme de DSN non supporté ('${scheme}:'). Attendu : postgres / postgresql / mongodb / mongodb+srv.`
	);
}

/**
 * Ping + info SAFE de source DSN — le CLI l'appelle à `sqlnest ping`
 * pour diagnostiquer un tunnel avant que le WS soit établi.
 */
export async function pingTunnel(
	tunnelName: string,
	env: NodeJS.ProcessEnv = process.env
): Promise<TunnelPingResult> {
	const source = describeConnectionForDiagnostics(tunnelName, env).source;
	const conn = await openConnectionForTunnel(tunnelName, env);
	try {
		const ping = await conn.ping();
		return { ...ping, source };
	} finally {
		await conn.close();
	}
}

/** Introspection du schéma via la connexion locale. Utile pour la
 * commande `sqlnest introspect` (à venir) et pour le futur WS Bloc 7. */
export async function introspectTunnel(
	tunnelName: string,
	env: NodeJS.ProcessEnv = process.env
): Promise<SchemaModel> {
	const conn = await openConnectionForTunnel(tunnelName, env);
	try {
		return await conn.introspect();
	} finally {
		await conn.close();
	}
}

/**
 * Exécute une source SNQL sur la connexion locale. Le pipeline complet
 * (parse → planner → pushdown → exécution) est fait dans
 * `@sqlnest/engine`. Le CLI ne voit ni le SQL généré ni les paramètres
 * dedans — juste l'entrée SNQL et le `ResultSet` résultat.
 */
export async function runSnqlOnTunnel(
	tunnelName: string,
	source: string,
	env: NodeJS.ProcessEnv = process.env
): Promise<ResultSet> {
	const conn = await openConnectionForTunnel(tunnelName, env);
	try {
		return await runQuery(conn, source);
	} finally {
		await conn.close();
	}
}
