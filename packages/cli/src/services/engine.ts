/**
 * Wrapper CLI sur `@sqlnest/engine` — ouvre une connexion Postgres locale
 * pour un tunnel donné, ping, introspection, exécution SNQL.
 *
 * ─── Rôle ─────────────────────────────────────────────────────────────
 * Ce module est le seul point du CLI qui manipule la DSN Postgres. Toute
 * autre partie (WS handler, commandes user) reçoit un `Connection` déjà
 * ouvert et n'accède JAMAIS à la string de connexion — protection
 * contre la fuite accidentelle dans un log/frame WS.
 *
 * ─── Réutilise l'engine du backend ─────────────────────────────────────
 * `@sqlnest/engine` expose `connect()`, `runQuery()` (SNQL → SQL Postgres
 * → exécution), et le driver `postgres.js` sous-jacent. Le CLI est un
 * miroir de la logique côté serveur — même code path, simplement exécuté
 * sur la machine du user avec ses creds.
 */

import { createHash } from "node:crypto";
import {
	type Connection,
	connect as engineConnect,
	type PingResult,
	type ResolvedEngineConfig,
	resolveMongoConfig,
	resolveMssqlConfig,
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
 * Détecte l'engine ("postgres" | "mongodb" | "mssql") depuis la DSN locale du
 * tunnel. Exposé pour que `serve` l'envoie au backend via heartbeat (backfill
 * db_connection.engine — le pairing initial stocke DEFAULT_ENGINE en dur).
 * Retourne null si la DSN ne peut pas être résolue (mode dégradé best-effort).
 */
export function detectEngineFromConnectionName(
	tunnelName: string,
	env: NodeJS.ProcessEnv = process.env
): "postgres" | "mongodb" | "mssql" | null {
	try {
		const url = resolveLocalConnectionUrl(tunnelName, env);
		const colonIdx = url.indexOf(":");
		const scheme = colonIdx > 0 ? url.slice(0, colonIdx).toLowerCase() : "";
		if (scheme === "postgres" || scheme === "postgresql") return "postgres";
		if (scheme === "mongodb" || scheme === "mongodb+srv") return "mongodb";
		if (scheme === "mssql" || scheme === "sqlserver") return "mssql";
		return null;
	} catch {
		return null;
	}
}

/**
 * Détecte l'engine cible depuis le scheme de la DSN et route vers le bon
 * resolver. Support : postgres/postgresql → PG, mongodb/mongodb+srv → Mongo,
 * mssql/sqlserver → MSSQL (M/1). Tout autre scheme = message clair.
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
	if (scheme === "mssql" || scheme === "sqlserver") {
		return resolveMssqlConfig({ url });
	}
	throw new Error(
		`Scheme de DSN non supporté ('${scheme}:'). Attendu : postgres / postgresql / mongodb / mongodb+srv / mssql / sqlserver.`
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
 * commande `sqlnest introspect` (à venir) et pour le WS. */
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
 * Calcule le fingerprint de l'INSTANCE DB visée par cette DSN locale.
 * Ouvre une connexion éphémère, appelle `Connection.fingerprint()`,
 * la referme. Best-effort : retourne `null` si la DSN n'est pas configurée
 * ou que le serveur ne répond pas — l'authenticate continue sans fingerprint
 * (le backend backfill au prochain succès).
 *
 * Rôle du fingerprint : c'est l'identité stable et cross-machine de la DB
 * (system_identifier PG / replSet Mongo — voir adapters). Deux CLI configurés
 * différemment (DSN via VPN vs LAN, user différent) qui pointent sur la MÊME
 * DB produisent le MÊME fingerprint → le backend peut re-associer un canvas
 * existant à un pairing depuis un autre device.
 */
export async function computeTunnelFingerprint(
	tunnelName: string,
	env: NodeJS.ProcessEnv = process.env
): Promise<string | null> {
	try {
		const conn = await openConnectionForTunnel(tunnelName, env);
		try {
			return await conn.fingerprint();
		} finally {
			await conn.close();
		}
	} catch {
		// DSN absente / server injoignable / auth refusée : silencieux — le
		// backend accepte l'authenticate sans fingerprint et fera un backfill
		// au prochain connect qui réussit.
		return null;
	}
}

/**
 * Calcule le CHECKSUM de la STRUCTURE (schéma) de la DB visée.
 * Complémentaire du fingerprint (identité INSTANCE) : deux DBs avec le
 * même schéma mais différentes (staging vs prod) auront le même checksum
 * mais des fingerprints différents. Une même DB après migration
 * (ADD COLUMN, etc.) garde son fingerprint mais change de checksum.
 *
 * Approche v1 : réutilise `conn.introspect()` (déjà appelé au boot du
 * serve loop pour le SchemaModel) et hash la représentation canonique
 * (collections triées, fields triés par nom, format `name:type:nullable`).
 * Best-effort : retourne `null` sur erreur — le backend backfill au
 * prochain heartbeat qui réussit.
 *
 * Format : `<engine>:<sha256[..32]>` — ex `postgres:0f2a...`, `mongodb:9b1c...`.
 */
export async function computeTunnelSchemaChecksum(
	tunnelName: string,
	env: NodeJS.ProcessEnv = process.env
): Promise<string | null> {
	try {
		const conn = await openConnectionForTunnel(tunnelName, env);
		try {
			const schema = await conn.introspect();
			return checksumOfSchema(schema);
		} finally {
			await conn.close();
		}
	} catch {
		return null;
	}
}

/**
 * Sérialisation canonique du SchemaModel + hash SHA256 tronqué à 32 hex.
 * L'ordre déterministe est CRUCIAL : deux appels sur la même DB doivent
 * produire le même hash. On trie collections + fields par nom + relations
 * par key (from-side lex).
 */
function checksumOfSchema(schema: SchemaModel): string {
	const collections = schema.collections
		.slice()
		.sort((a, b) => a.name.localeCompare(b.name))
		.map((c) => ({
			name: c.name,
			pk: (c.primaryKey ?? []).slice().sort(),
			fields: c.fields
				.slice()
				.sort((a, b) => a.name.localeCompare(b.name))
				.map(
					(f) => `${f.name}:${f.type}:${f.nullable === true ? "1" : "0"}`
				)
		}));
	const relations = schema.relations
		.slice()
		.map(
			(r) =>
				`${r.kind}:${r.from.collection}(${r.from.fields.join(",")})->${r.to.collection}(${r.to.fields.join(",")})`
		)
		.sort();
	const canonical = JSON.stringify({ collections, relations });
	const hex = createHash("sha256").update(canonical).digest("hex").slice(0, 32);
	return `${schema.engine}:${hex}`;
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
