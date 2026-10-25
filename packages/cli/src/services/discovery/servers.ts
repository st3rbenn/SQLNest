/**
 * Un serveur de bases lancé par Docker : moteur d'après l'image (ou le port
 * exposé), identifiants d'après les variables que l'image lit au démarrage.
 */

import {
	buildConnection,
	type DbEngine,
	DEFAULT_PORT,
	type ParsedConnection
} from "../connection-strings";
import type { DiscoveredServer } from "./types";

const IMAGE_ENGINES: readonly (readonly [RegExp, DbEngine])[] = [
	[/(^|\/)(postgres|postgresql|postgis|timescaledb(-ha)?)(:|@|$)/, "postgres"],
	[/(^|\/)(mongo|mongodb|mongodb-community-server)(:|@|$)/, "mongodb"],
	[/(^|\/)(mssql\/server|azure-sql-edge)(:|@|$)/, "mssql"]
];

/** Moteur d'une image, sinon du port exposé dans le conteneur. */
export function engineOf(
	image: string,
	containerPorts: readonly number[]
): DbEngine | undefined {
	const name = image.toLowerCase();
	for (const [re, engine] of IMAGE_ENGINES) if (re.test(name)) return engine;
	for (const [engine, port] of Object.entries(DEFAULT_PORT)) {
		if (containerPorts.includes(port)) return engine as DbEngine;
	}
	return undefined;
}

/** Hôte d'un port publié : toutes les interfaces ou la boucle locale → `localhost`. */
export function publishedHost(hostIp: string | undefined): string {
	return hostIp === undefined ||
		["", "0.0.0.0", "::", "127.0.0.1", "::1"].includes(hostIp)
		? "localhost"
		: hostIp;
}

/**
 * Serveur décrit par l'environnement de son conteneur : images officielles
 * (`POSTGRES_*`, `MONGO_INITDB_ROOT_*`, `MSSQL_SA_PASSWORD`) et Bitnami.
 */
export function serverFromEnv(
	engine: DbEngine,
	env: Readonly<Record<string, string | undefined>>,
	where: Pick<
		DiscoveredServer,
		"name" | "image" | "host" | "port" | "running" | "container" | "compose"
	>
): DiscoveredServer {
	const value = (...keys: string[]): string | undefined => {
		for (const key of keys) {
			const v = env[key];
			if (v !== undefined && v !== "") return v;
		}
		return undefined;
	};
	if (engine === "postgres") {
		const user = value("POSTGRES_USER", "POSTGRESQL_USERNAME") ?? "postgres";
		const database = value("POSTGRES_DB", "POSTGRESQL_DATABASE") ?? user;
		return {
			...where,
			engine,
			user,
			password:
				value("POSTGRES_PASSWORD", "POSTGRESQL_PASSWORD") ??
				(user === "postgres"
					? value("POSTGRESQL_POSTGRES_PASSWORD")
					: undefined),
			passwordless:
				env.POSTGRES_HOST_AUTH_METHOD === "trust" ||
				env.ALLOW_EMPTY_PASSWORD === "yes",
			maintenanceDatabase: database,
			defaultDatabase: database,
			params: {}
		};
	}
	if (engine === "mongodb") {
		const rootPassword = value("MONGODB_ROOT_PASSWORD");
		const user =
			value("MONGO_INITDB_ROOT_USERNAME") ??
			(rootPassword !== undefined
				? (value("MONGODB_ROOT_USER") ?? "root")
				: undefined);
		return {
			...where,
			engine,
			user,
			password: value("MONGO_INITDB_ROOT_PASSWORD") ?? rootPassword,
			passwordless: user === undefined,
			maintenanceDatabase: "admin",
			defaultDatabase: value("MONGO_INITDB_DATABASE", "MONGODB_DATABASE"),
			// Un seul nœud derrière un port publié : pas de découverte du
			// replica set, dont les membres portent des noms internes à Docker.
			params: {
				directConnection: "true",
				...(user !== undefined ? { authSource: "admin" } : {})
			}
		};
	}
	return {
		...where,
		engine,
		user: "sa",
		password: value("MSSQL_SA_PASSWORD", "SA_PASSWORD"),
		passwordless: false,
		maintenanceDatabase: "master",
		defaultDatabase: undefined,
		// Les images SQL Server présentent un certificat auto-signé.
		params: { trustServerCertificate: "true" }
	};
}

/** Connexion à une base du serveur. */
export function serverConnection(
	server: DiscoveredServer,
	database: string,
	password: string | undefined = server.password
): ParsedConnection {
	return buildConnection(server.engine, {
		host: server.host,
		port: server.port,
		database,
		user: server.user,
		password,
		params: server.params
	});
}
