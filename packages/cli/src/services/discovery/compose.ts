/**
 * `docker compose` d'un dossier projet, lu par `docker compose config` : la
 * config résolue (fichier d'override, `env_file`, `${VAR}`) telle que
 * `docker compose up` la verrait, sans parser le YAML soi-même.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { DockerRunner } from "./docker";

const COMPOSE_FILES = [
	"compose.yaml",
	"compose.yml",
	"docker-compose.yaml",
	"docker-compose.yml"
];

export interface ComposePort {
	readonly target: number;
	readonly published: number | undefined;
	readonly hostIp: string | undefined;
}

export interface ComposeService {
	readonly name: string;
	readonly image: string | undefined;
	readonly containerName: string | undefined;
	readonly environment: Readonly<Record<string, string>>;
	readonly ports: readonly ComposePort[];
	/** Dossiers de l'hôte : contexte de build, montages. */
	readonly dirs: readonly string[];
}

export interface ComposeProject {
	readonly name: string;
	readonly file: string;
	readonly services: readonly ComposeService[];
}

interface RawService {
	readonly image?: string;
	readonly container_name?: string;
	readonly environment?: Readonly<Record<string, string | null>> | null;
	readonly ports?: readonly {
		readonly target?: number;
		readonly published?: string | number;
		readonly host_ip?: string;
	}[];
	readonly build?: { readonly context?: string };
	readonly volumes?: readonly {
		readonly type?: string;
		readonly source?: string;
	}[];
}

export function findComposeFile(dir: string): string | undefined {
	return COMPOSE_FILES.map((f) => join(dir, f)).find((f) => existsSync(f));
}

export async function loadComposeProject(
	dir: string,
	docker: DockerRunner
): Promise<ComposeProject | undefined> {
	const file = findComposeFile(dir);
	if (file === undefined) return undefined;
	const out = await docker(["compose", "config", "--format", "json"], dir);
	if (out === undefined) return undefined;
	let config: {
		readonly name?: string;
		readonly services?: Readonly<Record<string, RawService>>;
	};
	try {
		config = JSON.parse(out) as typeof config;
	} catch {
		return undefined;
	}
	const services = Object.entries(config.services ?? {}).map(
		([name, raw]): ComposeService => ({
			name,
			image: raw.image,
			containerName: raw.container_name,
			environment: Object.fromEntries(
				Object.entries(raw.environment ?? {}).filter(
					(e): e is [string, string] => typeof e[1] === "string"
				)
			),
			ports: (raw.ports ?? []).flatMap((p) =>
				p.target !== undefined
					? [
							{
								target: p.target,
								published:
									p.published !== undefined && p.published !== ""
										? Number(p.published)
										: undefined,
								hostIp: p.host_ip
							}
						]
					: []
			),
			dirs: [
				...(raw.build?.context !== undefined ? [raw.build.context] : []),
				...(raw.volumes ?? []).flatMap((v) =>
					v.type === "bind" && v.source !== undefined ? [v.source] : []
				)
			]
		})
	);
	return { name: config.name ?? "", file, services };
}
