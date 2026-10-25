/**
 * Bases trouvées sur la machine (ADR-038 S1) : le projet courant et les
 * conteneurs Docker en cours. Une source = un module. Rien ne quitte la
 * machine : les secrets lus servent à se connecter, jamais à s'afficher.
 */

import { homedir } from "node:os";
import {
	connectionIdentity,
	parseConnectionString
} from "../connection-strings";
import { entryUrl, type LocalConnectionEntry } from "../local-connections";
import {
	type DockerRunner,
	defaultDockerRunner,
	discoverContainers
} from "./docker";
import { discoverProject } from "./project";
import type { DiscoveredServer, Discovery } from "./types";

export type { DockerRunner } from "./docker";
export { serverConnection } from "./servers";
export type * from "./types";

export interface DiscoverOptions {
	readonly cwd?: string;
	readonly home?: string;
	readonly env?: NodeJS.ProcessEnv;
	readonly docker?: DockerRunner;
}

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
	// Un service compose qui tourne est l'un des conteneurs : une seule entrée,
	// celle du conteneur (son environnement réel).
	const running = new Set<DiscoveredServer>();
	const servers = project.servers.map((server) => {
		const container = containers.find((c) => sameServer(c, server));
		if (container === undefined) return server;
		running.add(container);
		return container;
	});
	return {
		root: project.root,
		databases: project.databases,
		servers: [...servers, ...containers.filter((c) => !running.has(c))],
		unresolved: project.unresolved
	};
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

function sameServer(
	container: DiscoveredServer,
	composed: DiscoveredServer
): boolean {
	return container.compose !== undefined && composed.compose !== undefined
		? container.compose.project === composed.compose.project &&
				container.compose.service === composed.compose.service
		: container.host === composed.host && container.port === composed.port;
}
