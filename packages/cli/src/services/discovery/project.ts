/**
 * Bases du projet courant (ADR-038 S1) : `.env`, config de l'ORM, services
 * `docker compose`. Une URL qui vise un service compose (`@db:5432`) passe
 * par le port publié sur la machine (`localhost:5440`).
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { detectOrms, type OrmDetection } from "../../orm/detect";
import {
	buildConnection,
	connectionIdentity,
	type DbEngine,
	DEFAULT_PORT,
	type ParsedConnection,
	parseConnectionString,
	withHostPort
} from "../connection-strings";
import { parseDotenv } from "../dotenv";
import {
	type ComposeProject,
	type ComposeService,
	findComposeFile,
	loadComposeProject
} from "./compose";
import type { DockerRunner } from "./docker";
import { engineOf, publishedHost, serverFromEnv } from "./servers";
import type {
	DiscoveredDatabase,
	DiscoveredServer,
	UnresolvedOrm
} from "./types";
import { workspaceDirs } from "./workspace";

/** Fichiers lus, dans l'ordre où dotenv, Next ou Symfony les superposent. */
export const ENV_FILES = [
	".env",
	".env.local",
	".env.development",
	".env.development.local"
];
const ROOT_MARKERS = ["package.json", "composer.json", "Cargo.toml"];
const MAX_LEVELS = 6;
/** Base fantôme de Prisma (`shadowDatabaseUrl`) : jamais une base à servir. */
const SHADOW_KEY_RE = /shadow/i;
const DOCKER_HOST_ALIASES = new Set([
	"host.docker.internal",
	"gateway.docker.internal"
]);
const LARAVEL_ENGINES: Readonly<Record<string, DbEngine>> = {
	pgsql: "postgres",
	sqlsrv: "mssql",
	mongodb: "mongodb"
};

export interface ProjectDiscovery {
	readonly root: string | undefined;
	readonly databases: readonly DiscoveredDatabase[];
	/** Services compose de bases, comme décrits par leur fichier. */
	readonly servers: readonly DiscoveredServer[];
	readonly unresolved: readonly UnresolvedOrm[];
}

/**
 * Dossiers du projet, du plus proche au plus lointain : du dossier courant à
 * la racine du dépôt git, sinon au premier dossier qui porte un manifeste —
 * jamais le dossier personnel ni au-delà.
 */
export function projectDirs(
	cwd: string,
	home: string
): { readonly dirs: string[]; readonly root: string } | undefined {
	if (cwd === home) return undefined;
	const chain: string[] = [];
	let dir = cwd;
	for (let level = 0; level < MAX_LEVELS; level += 1) {
		chain.push(dir);
		if (existsSync(join(dir, ".git"))) return { dirs: chain, root: dir };
		const parent = dirname(dir);
		if (parent === dir || parent === home) break;
		dir = parent;
	}
	const marker = chain.findIndex((d) =>
		ROOT_MARKERS.some((m) => existsSync(join(d, m)))
	);
	return marker < 0
		? { dirs: [cwd], root: cwd }
		: { dirs: chain.slice(0, marker + 1), root: chain[marker] as string };
}

interface EnvFile {
	readonly file: string;
	readonly values: Readonly<Record<string, string>>;
}

export async function discoverProject(
	cwd: string,
	home: string,
	env: NodeJS.ProcessEnv,
	docker: DockerRunner
): Promise<ProjectDiscovery> {
	const scope = projectDirs(cwd, home);
	if (scope === undefined) {
		return { root: undefined, databases: [], servers: [], unresolved: [] };
	}
	// Un monorepo range ses applications dans des sous-dossiers : membres
	// déclarés, dossiers à manifeste, puis ceux des services compose
	// (contexte de build, montages).
	const dirs = [...scope.dirs];
	for (const dir of workspaceDirs(scope.root)) {
		if (!dirs.includes(dir)) dirs.push(dir);
	}
	const composes = (
		await Promise.all(
			dirs
				.filter((d) => findComposeFile(d) !== undefined)
				.map((d) => loadComposeProject(d, docker))
		)
	).filter((p): p is ComposeProject => p !== undefined);
	const route = composeRouter(composes);
	for (const service of composes.flatMap((p) => p.services)) {
		for (const dir of service.dirs) {
			if (isInside(dir, scope.root) && !dirs.includes(dir) && existsSync(dir)) {
				dirs.push(dir);
			}
		}
	}

	const envFiles = dirs.flatMap((dir) => readEnvFiles(dir, env));
	const databases: Ranked[] = [];
	for (const { file, values } of envFiles) {
		for (const [key, value] of Object.entries(values)) {
			if (SHADOW_KEY_RE.test(key)) continue;
			const parsed = parseConnectionString(value);
			const routed = parsed !== undefined ? route(parsed) : undefined;
			if (routed === undefined) continue;
			databases.push({
				connection: routed,
				source: { kind: "env-file", file, key },
				// Réécrite vers le port publié, la valeur du `.env` ne sert pas
				// telle quelle depuis la machine : copie, pas référence.
				...(routed === parsed ? { urlFrom: { file, key } } : {}),
				rank: routed === parsed ? 0 : 1
			});
		}
		const laravel = laravelConnection(values);
		const routed = laravel !== undefined ? route(laravel) : undefined;
		if (routed !== undefined) {
			databases.push({
				connection: routed,
				source: { kind: "env-file", file, key: "DB_*" },
				rank: 1
			});
		}
	}
	for (const project of composes) {
		for (const service of project.services) {
			for (const [key, value] of Object.entries(service.environment)) {
				if (SHADOW_KEY_RE.test(key)) continue;
				const parsed = parseConnectionString(value);
				const routed = parsed !== undefined ? route(parsed) : undefined;
				if (routed === undefined) continue;
				databases.push({
					connection: routed,
					source: {
						kind: "compose",
						file: project.file,
						service: service.name,
						key
					},
					rank: 3
				});
			}
		}
	}

	const unresolved: UnresolvedOrm[] = [];
	const orms = new Map<Ranked, OrmDetection>();
	for (const detection of dirs.flatMap((dir) => detectOrms(dir))) {
		if (detection.url !== undefined) {
			const parsed = parseConnectionString(detection.url);
			const routed = parsed !== undefined ? route(parsed) : undefined;
			if (routed === undefined) continue;
			const database: Ranked = {
				connection: routed,
				source: { kind: "orm-config", file: detection.configFile },
				rank: 2
			};
			databases.push(database);
			orms.set(database, detection);
			continue;
		}
		const key = detection.envKey;
		const match =
			key !== undefined
				? ormDatabase(databases, composes, detection, key)
				: undefined;
		if (match !== undefined) {
			if (!orms.has(match)) orms.set(match, detection);
		} else if (
			key === undefined ||
			!definesKey(envFiles, composes, detection.dir, key)
		) {
			unresolved.push({
				orm: detection,
				reason:
					key !== undefined
						? `${key} introuvable`
						: "base introuvable dans sa config"
			});
		}
	}

	return {
		root: scope.root,
		databases: dedupe(databases, orms, dirs),
		servers: composeServers(composes),
		unresolved
	};
}

interface Ranked extends DiscoveredDatabase {
	/** Préférence entre deux sources d'une même base : la plus basse gagne. */
	readonly rank: number;
}

function readEnvFiles(dir: string, env: NodeJS.ProcessEnv): EnvFile[] {
	return ENV_FILES.flatMap((name) => {
		const file = join(dir, name);
		try {
			return [{ file, values: parseDotenv(readFileSync(file, "utf8"), env) }];
		} catch {
			return [];
		}
	});
}

/** `DB_CONNECTION` / `DB_HOST` / … (Laravel). */
function laravelConnection(
	values: Readonly<Record<string, string>>
): ParsedConnection | undefined {
	const engine = LARAVEL_ENGINES[values.DB_CONNECTION ?? ""];
	const host = values.DB_HOST;
	if (engine === undefined || host === undefined || host === "")
		return undefined;
	const port = Number(values.DB_PORT);
	return buildConnection(engine, {
		host: host.toLowerCase(),
		port: Number.isInteger(port) && port > 0 ? port : undefined,
		database: values.DB_DATABASE,
		user: values.DB_USERNAME,
		password: values.DB_PASSWORD,
		params: {}
	});
}

/**
 * Connexion vue depuis la machine : un hôte qui est un service compose passe
 * par son port publié ; `undefined` si ce port n'est pas publié.
 */
function composeRouter(
	composes: readonly ComposeProject[]
): (c: ParsedConnection) => ParsedConnection | undefined {
	const byHost = new Map<string, ComposeService>();
	for (const service of composes.flatMap((p) => p.services)) {
		byHost.set(service.name.toLowerCase(), service);
		if (service.containerName !== undefined) {
			byHost.set(service.containerName.toLowerCase(), service);
		}
	}
	return (c) => {
		// L'hôte vu depuis un conteneur ; depuis la machine, c'est elle-même.
		if (DOCKER_HOST_ALIASES.has(c.host)) {
			return withHostPort(c, "localhost", c.port ?? DEFAULT_PORT[c.engine]);
		}
		const service = byHost.get(c.host);
		if (service === undefined) return c;
		const target = c.port ?? DEFAULT_PORT[c.engine];
		const port = service.ports.find(
			(p) => p.target === target && p.published !== undefined
		);
		return port !== undefined
			? withHostPort(c, publishedHost(port.hostIp), port.published as number)
			: undefined;
	};
}

/** Base que lit l'ORM : `.env` de son dossier ou d'un parent, sinon son service compose. */
function ormDatabase(
	databases: readonly Ranked[],
	composes: readonly ComposeProject[],
	detection: OrmDetection,
	key: string
): Ranked | undefined {
	const fromEnv = databases
		.filter(
			(d) =>
				d.source.kind === "env-file" &&
				d.source.key === key &&
				isInside(detection.dir, dirname(d.source.file))
		)
		.sort(
			(a, b) => dirname(sourceFile(b)).length - dirname(sourceFile(a)).length
		)[0];
	if (fromEnv !== undefined) return fromEnv;
	const services = new Set(
		composes
			.flatMap((p) => p.services)
			.filter((s) => s.dirs.includes(detection.dir))
			.map((s) => s.name)
	);
	return databases.find(
		(d) =>
			d.source.kind === "compose" &&
			d.source.key === key &&
			services.has(d.source.service)
	);
}

/** La variable existe (valeur non reconnue : moteur que SQLNest ne sert pas). */
function definesKey(
	envFiles: readonly EnvFile[],
	composes: readonly ComposeProject[],
	dir: string,
	key: string
): boolean {
	return (
		envFiles.some(
			(f) => isInside(dir, dirname(f.file)) && f.values[key] !== undefined
		) ||
		composes.some((p) =>
			p.services.some(
				(s) => s.dirs.includes(dir) && s.environment[key] !== undefined
			)
		)
	);
}

/**
 * Une entrée par base : la meilleure source, l'ORM de l'une ou l'autre.
 * Celles d'un ORM d'abord, la plus proche du dossier courant en tête.
 */
function dedupe(
	databases: readonly Ranked[],
	orms: ReadonlyMap<Ranked, OrmDetection>,
	dirs: readonly string[]
): DiscoveredDatabase[] {
	const byIdentity = new Map<string, Ranked[]>();
	for (const database of databases) {
		const identity = connectionIdentity(database.connection);
		byIdentity.set(identity, [...(byIdentity.get(identity) ?? []), database]);
	}
	const out: DiscoveredDatabase[] = [];
	for (const group of byIdentity.values()) {
		const [best] = [...group].sort((a, b) => a.rank - b.rank) as [Ranked];
		const orm = group.map((d) => orms.get(d)).find((o) => o !== undefined);
		out.push({
			connection: best.connection,
			source: best.source,
			...(best.urlFrom !== undefined ? { urlFrom: best.urlFrom } : {}),
			...(orm !== undefined ? { orm } : {})
		});
	}
	const near = (d: DiscoveredDatabase): number =>
		dirs.indexOf(d.orm?.dir ?? "");
	return [
		...out.filter((d) => d.orm !== undefined).sort((a, b) => near(a) - near(b)),
		...out.filter((d) => d.orm === undefined)
	];
}

function composeServers(
	composes: readonly ComposeProject[]
): DiscoveredServer[] {
	return composes.flatMap((project) =>
		project.services.flatMap((service) => {
			const engine = engineOf(
				service.image ?? "",
				service.ports.map((p) => p.target)
			);
			if (engine === undefined) return [];
			const port = service.ports.find(
				(p) => p.target === DEFAULT_PORT[engine] && p.published !== undefined
			);
			if (port === undefined) return [];
			return [
				serverFromEnv(engine, service.environment, {
					name: service.containerName ?? service.name,
					image: service.image ?? "",
					host: publishedHost(port.hostIp),
					port: port.published as number,
					running: false,
					compose: {
						project: project.name,
						service: service.name,
						dir: dirname(project.file)
					}
				})
			];
		})
	);
}

function sourceFile(d: DiscoveredDatabase): string {
	return d.source.file;
}

/** `path` est `dir` ou l'un de ses sous-dossiers. */
export function isInside(path: string, dir: string): boolean {
	return (
		path === dir || path.startsWith(dir.endsWith(sep) ? dir : `${dir}${sep}`)
	);
}
