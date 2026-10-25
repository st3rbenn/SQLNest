/**
 * Conteneurs Docker de bases (ADR-038 S1) : Postgres, Mongo, SQL Server, en
 * cours ou arrêtés, leur port publié et leurs identifiants. Seuls les
 * conteneurs de bases sont inspectés, et seules les variables d'identifiants
 * sont lues. Sans Docker (absent, arrêté, lent), la source est vide.
 */

import { execFile } from "node:child_process";
import { DEFAULT_PORT } from "../connection-strings";
import { engineOf, publishedHost, serverFromEnv } from "./servers";
import type { DiscoveredServer } from "./types";

/** Lance `docker <args>` dans `cwd` ; `undefined` si Docker manque, échoue ou tarde. */
export type DockerRunner = (
	args: readonly string[],
	cwd?: string
) => Promise<string | undefined>;

const DOCKER_TIMEOUT_MS = 4000;
const START_TIMEOUT_MS = 60_000;
const PUBLISHED_PORT_RE = /->(\d+)\/tcp/g;
const LEADING_SLASH_RE = /^\//;

export const defaultDockerRunner: DockerRunner = (args, cwd) =>
	runDocker(args, cwd).catch(() => undefined);

/** `docker <args>` ; rejette avec la dernière ligne d'erreur de Docker. */
export function runDocker(
	args: readonly string[],
	cwd?: string,
	timeout = DOCKER_TIMEOUT_MS
): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(
			"docker",
			[...args],
			{
				timeout,
				maxBuffer: 16 * 1024 * 1024,
				...(cwd !== undefined ? { cwd } : {})
			},
			(err, stdout, stderr) => {
				if (err === null) {
					resolve(stdout);
					return;
				}
				const detail = stderr.trim().split("\n").at(-1);
				reject(
					new Error(
						detail !== undefined && detail !== "" ? detail : err.message
					)
				);
			}
		);
	});
}

/**
 * Démarre un serveur arrêté : son conteneur tel qu'il a été créé (ports
 * compris), sinon son service compose.
 */
export async function startDockerServer(
	server: DiscoveredServer,
	run: typeof runDocker = runDocker
): Promise<void> {
	if (server.container !== undefined) {
		await run(["start", server.container], undefined, START_TIMEOUT_MS);
	} else if (server.compose?.dir !== undefined) {
		await run(
			["compose", "up", "-d", server.compose.service],
			server.compose.dir,
			START_TIMEOUT_MS
		);
	} else {
		throw new Error(
			`${server.name} : ni conteneur ni service compose à démarrer`
		);
	}
}

interface PsLine {
	readonly ID: string;
	readonly Image: string;
	readonly Ports: string;
}

type PortBindings = Readonly<
	Record<
		string,
		readonly { readonly HostIp?: string; readonly HostPort?: string }[] | null
	>
>;

interface Inspected {
	readonly Name: string;
	readonly State?: { readonly Running?: boolean };
	readonly HostConfig?: { readonly PortBindings?: PortBindings | null };
	readonly Config?: {
		readonly Image?: string;
		readonly Env?: readonly string[];
		readonly Labels?: Readonly<Record<string, string>> | null;
	};
	readonly NetworkSettings?: { readonly Ports?: PortBindings | null };
}

export async function discoverContainers(
	docker: DockerRunner
): Promise<DiscoveredServer[]> {
	const ps = await docker(["ps", "-a", "--format", "{{json .}}"]);
	if (ps === undefined) return [];
	const candidates = ps
		.split("\n")
		.filter((line) => line.trim() !== "")
		.flatMap((line) => {
			try {
				return [JSON.parse(line) as PsLine];
			} catch {
				return [];
			}
		})
		// Un conteneur arrêté n'a plus de port dans `ps` : l'image dit le moteur.
		.filter((c) => {
			const ports = [...c.Ports.matchAll(PUBLISHED_PORT_RE)].map((m) =>
				Number(m[1])
			);
			return engineOf(c.Image, ports) !== undefined;
		});
	if (candidates.length === 0) return [];
	const raw = await docker(["inspect", ...candidates.map((c) => c.ID)]);
	if (raw === undefined) return [];
	let inspected: Inspected[];
	try {
		inspected = JSON.parse(raw) as Inspected[];
	} catch {
		return [];
	}
	return inspected.flatMap((container) => {
		const server = serverOfContainer(container);
		return server !== undefined ? [server] : [];
	});
}

function serverOfContainer(container: Inspected): DiscoveredServer | undefined {
	const running = container.State?.Running === true;
	// Arrêté : les ports publiés ne restent que dans la config du conteneur.
	const live = container.NetworkSettings?.Ports ?? {};
	const ports =
		running && Object.keys(live).length > 0
			? live
			: (container.HostConfig?.PortBindings ?? live);
	const image = container.Config?.Image ?? "";
	const engine = engineOf(
		image,
		Object.keys(ports).map((p) => Number.parseInt(p, 10))
	);
	if (engine === undefined) return undefined;
	const binding = ports[`${DEFAULT_PORT[engine]}/tcp`]?.find(
		(b) => b.HostPort !== undefined && b.HostPort !== ""
	);
	if (binding === undefined) return undefined;
	const env: Record<string, string> = {};
	for (const pair of container.Config?.Env ?? []) {
		const eq = pair.indexOf("=");
		if (eq > 0) env[pair.slice(0, eq)] = pair.slice(eq + 1);
	}
	const labels = container.Config?.Labels ?? {};
	const project = labels["com.docker.compose.project"];
	const service = labels["com.docker.compose.service"];
	const dir = labels["com.docker.compose.project.working_dir"];
	const name = container.Name.replace(LEADING_SLASH_RE, "");
	return serverFromEnv(engine, env, {
		name,
		image,
		host: publishedHost(binding.HostIp),
		port: Number(binding.HostPort),
		running,
		container: name,
		...(project !== undefined && service !== undefined
			? { compose: { project, service, ...(dir !== undefined ? { dir } : {}) } }
			: {})
	});
}
