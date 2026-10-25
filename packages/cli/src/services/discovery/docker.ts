/**
 * Conteneurs Docker en cours (ADR-038 S1) : Postgres, Mongo, SQL Server,
 * leur port publié et leurs identifiants. Seuls les conteneurs de bases sont
 * inspectés, et seules les variables d'identifiants sont lues. Sans Docker
 * (absent, arrêté, lent), la source est vide.
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
const PUBLISHED_PORT_RE = /->(\d+)\/tcp/g;
const LEADING_SLASH_RE = /^\//;

export const defaultDockerRunner: DockerRunner = (args, cwd) =>
	new Promise((resolve) => {
		execFile(
			"docker",
			[...args],
			{
				timeout: DOCKER_TIMEOUT_MS,
				maxBuffer: 16 * 1024 * 1024,
				...(cwd !== undefined ? { cwd } : {})
			},
			(err, stdout) => resolve(err === null ? stdout : undefined)
		);
	});

interface PsLine {
	readonly ID: string;
	readonly Image: string;
	readonly Ports: string;
}

interface Inspected {
	readonly Name: string;
	readonly Config?: {
		readonly Image?: string;
		readonly Env?: readonly string[];
		readonly Labels?: Readonly<Record<string, string>> | null;
	};
	readonly NetworkSettings?: {
		readonly Ports?: Readonly<
			Record<
				string,
				| readonly { readonly HostIp?: string; readonly HostPort?: string }[]
				| null
			>
		> | null;
	};
}

export async function discoverContainers(
	docker: DockerRunner
): Promise<DiscoveredServer[]> {
	const ps = await docker(["ps", "--format", "{{json .}}"]);
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
		.filter((c) => {
			const ports = [...c.Ports.matchAll(PUBLISHED_PORT_RE)].map((m) =>
				Number(m[1])
			);
			return ports.length > 0 && engineOf(c.Image, ports) !== undefined;
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
	const ports = container.NetworkSettings?.Ports ?? {};
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
	return serverFromEnv(engine, env, {
		name: container.Name.replace(LEADING_SLASH_RE, ""),
		image,
		host: publishedHost(binding.HostIp),
		port: Number(binding.HostPort),
		running: true,
		...(project !== undefined && service !== undefined
			? { compose: { project, service } }
			: {})
	});
}
