/**
 * Bases trouvées sur la machine (ADR-038 S1) : le projet courant et les
 * conteneurs Docker en cours. Une source = un module. Rien ne quitte la
 * machine : les secrets lus servent à se connecter, jamais à s'afficher.
 */

import { createConnection } from "node:net";
import { homedir } from "node:os";
import {
	connectionIdentity,
	DEFAULT_PORT,
	parseConnectionString
} from "../connection-strings";
import { entryUrl, type LocalConnectionEntry } from "../local-connections";
import {
	type DockerRunner,
	defaultDockerRunner,
	discoverContainers
} from "./docker";
import { discoverProject, isInside } from "./project";
import type { DiscoveredDatabase, DiscoveredServer, Discovery } from "./types";

export type { DockerRunner } from "./docker";
export { startDockerServer } from "./docker";
export { serverConnection } from "./servers";
export type * from "./types";

export interface DiscoverOptions {
	readonly cwd?: string;
	readonly home?: string;
	readonly env?: NodeJS.ProcessEnv;
	readonly docker?: DockerRunner;
	/** Un port de la machine répond-il ? (base servie hors de Docker). */
	readonly portOpen?: (host: string, port: number) => Promise<boolean>;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const PORT_PROBE_MS = 300;

export async function discoverDatabases(
	opts: DiscoverOptions = {}
): Promise<Discovery> {
	const docker = opts.docker ?? defaultDockerRunner;
	const [project, containers] = await Promise.all([
		discoverProject(
			opts.cwd ?? process.cwd(),
			opts.home ?? homedir(),
			opts.env ?? process.env,
			docker
		),
		discoverContainers(docker)
	]);
	// Un service compose qui a un conteneur, c'est ce conteneur (son
	// environnement et ses ports réels) ; un conteneur lancé depuis le projet
	// en est un serveur, même si son compose n'a pas été lu.
	const taken = new Set<DiscoveredServer>();
	const projectServers = project.servers.map((server) => {
		const container = containers.find((c) => sameServer(c, server));
		if (container === undefined) return server;
		taken.add(container);
		return container;
	});
	const root = project.root;
	for (const container of containers) {
		const dir = container.compose?.dir;
		if (
			!taken.has(container) &&
			root !== undefined &&
			dir !== undefined &&
			isInside(dir, root)
		) {
			taken.add(container);
			projectServers.push(container);
		}
	}
	const servers = containers
		.filter((c) => !taken.has(c))
		.sort((a, b) => Number(b.running) - Number(a.running));
	const portOpen = opts.portOpen ?? isPortOpen;
	const databases = await Promise.all(
		project.databases.map(async (database) => {
			const server = servingServer(database, projectServers, servers);
			if (server === undefined) return database;
			// Un conteneur arrêté qui déclare ce port ne sert la base que si
			// rien d'autre n'y répond déjà.
			if (!server.running && (await portOpen(server.host, server.port))) {
				return database;
			}
			return { ...database, server };
		})
	);
	return {
		root,
		databases,
		projectServers,
		servers,
		unresolved: project.unresolved
	};
}

/** Serveur qui publie le port local de la base : en cours, sinon du projet. */
function servingServer(
	database: DiscoveredDatabase,
	projectServers: readonly DiscoveredServer[],
	servers: readonly DiscoveredServer[]
): DiscoveredServer | undefined {
	const c = database.connection;
	if (!LOCAL_HOSTS.has(c.host)) return undefined;
	const port = c.port ?? DEFAULT_PORT[c.engine];
	const candidates = [...projectServers, ...servers].filter(
		(s) => s.engine === c.engine && LOCAL_HOSTS.has(s.host) && s.port === port
	);
	return candidates.find((s) => s.running) ?? candidates[0];
}

function isPortOpen(host: string, port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = createConnection({ host, port });
		const done = (open: boolean): void => {
			socket.destroy();
			resolve(open);
		};
		socket.setTimeout(PORT_PROBE_MS, () => done(false));
		socket.once("connect", () => done(true));
		socket.once("error", () => done(false));
	});
}

/** Connexions enregistrées, par identité de leur base (ADR-038 S1). */
export function configuredIdentities(
	entries: readonly LocalConnectionEntry[]
): Map<string, string> {
	const identities = new Map<string, string>();
	for (const entry of entries) {
		let url: string;
		try {
			url = entryUrl(entry);
		} catch {
			continue;
		}
		const parsed = parseConnectionString(url);
		if (parsed === undefined) continue;
		const identity = connectionIdentity(parsed);
		if (!identities.has(identity)) identities.set(identity, entry.name);
	}
	return identities;
}

/**
 * Même serveur : même service compose — et même dossier quand les deux le
 * disent, deux dépôts pouvant porter le même nom de projet (« backend ») —,
 * sinon même port publié.
 */
function sameServer(
	container: DiscoveredServer,
	composed: DiscoveredServer
): boolean {
	const a = container.compose;
	const b = composed.compose;
	if (a === undefined || b === undefined) {
		return container.host === composed.host && container.port === composed.port;
	}
	return (
		a.project === b.project &&
		a.service === b.service &&
		(a.dir === undefined || b.dir === undefined || a.dir === b.dir)
	);
}
