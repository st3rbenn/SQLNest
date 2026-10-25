/**
 * Détection de l'ORM d'un dossier (ADR-038 S1) et de l'endroit où il lit sa
 * base : une variable d'environnement, ou une chaîne écrite dans sa config.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildConnection, type DbEngine } from "../services/connection-strings";
import type { OrmName } from "./types";

export interface OrmDetection {
	readonly orm: OrmName;
	/** Dossier du projet. */
	readonly dir: string;
	/** Fichier qui désigne la base : `schema.prisma`, `doctrine.yaml`… */
	readonly configFile: string;
	/** Variable d'environnement qui porte l'URL de la base. */
	readonly envKey?: string;
	/** Chaîne de connexion écrite dans la config. */
	readonly url?: string;
}

const ENV_KEY = "[A-Za-z_][A-Za-z0-9_]*";
const PRISMA_DATASOURCE_RE = /datasource\s+\w+\s*\{([^}]*)\}/;
const PRISMA_URL_ENV_RE = new RegExp(
	`(?:^|\\n)\\s*url\\s*=\\s*env\\(\\s*"(${ENV_KEY})"\\s*\\)`
);
const PRISMA_URL_LITERAL_RE = /(?:^|\n)\s*url\s*=\s*"([^"]+)"/;
const PRISMA_CONFIG_URL_RE = new RegExp(
	`url\\s*:\\s*(?:env\\(\\s*["'\`](${ENV_KEY})["'\`]\\s*\\)|process\\.env\\.(${ENV_KEY})|process\\.env\\[\\s*["'](${ENV_KEY})["']\\s*\\])`
);
const DOCTRINE_URL_RE = new RegExp(
	`url\\s*:\\s*['"]?%env\\((?:[a-z]+:)*(${ENV_KEY})\\)%`
);
const SEQUELIZE_ENV_RE = new RegExp(
	`use_env_variable["']?\\s*:\\s*["'](${ENV_KEY})["']`
);
const SEQUELIZERC_CONFIG_RE =
	/["']?config["']?\s*:\s*(?:path\.(?:resolve|join)\(([^)]*)\)|["']([^"']+)["'])/;
const STRING_LITERAL_RE = /["']([^"']*)["']/g;
const SEA_ORM_RE =
	/^\s*(?:["']?sea-orm(?:-migration)?["']?\s*=|\[(?:[\w-]+\.)*dependencies\.sea-orm(?:-migration)?\])/m;

const DOCTRINE_PACKAGES = [
	"doctrine/orm",
	"doctrine/doctrine-bundle",
	"doctrine/migrations",
	"doctrine/doctrine-migrations-bundle"
];
const SEQUELIZE_CONFIGS = [
	"config/config.json",
	"config/config.js",
	"config/database.json",
	"config/database.js"
];
const SEQUELIZE_DIALECTS: Readonly<Record<string, DbEngine>> = {
	postgres: "postgres",
	mssql: "mssql"
};

/** ORM utilisés dans `dir` (souvent un seul). */
export function detectOrms(dir: string): OrmDetection[] {
	const found: OrmDetection[] = [];
	for (const detect of [
		detectPrisma,
		detectDoctrine,
		detectSequelize,
		detectSeaOrm
	]) {
		const detection = detect(dir);
		if (detection !== undefined) found.push(detection);
	}
	return found;
}

function detectPrisma(dir: string): OrmDetection | undefined {
	const packageJson = readJson(join(dir, "package.json"));
	const declared = (packageJson?.prisma as { schema?: unknown } | undefined)
		?.schema;
	const candidates = [
		...(typeof declared === "string" ? [join(dir, declared)] : []),
		join(dir, "prisma", "schema.prisma"),
		join(dir, "schema.prisma"),
		join(dir, "prisma", "schema")
	];
	for (const candidate of candidates) {
		for (const file of prismaFiles(candidate)) {
			const datasource = PRISMA_DATASOURCE_RE.exec(readText(file) ?? "");
			if (datasource === null) continue;
			const body = datasource[1] as string;
			const envKey = PRISMA_URL_ENV_RE.exec(body)?.[1];
			const url = PRISMA_URL_LITERAL_RE.exec(body)?.[1];
			if (envKey !== undefined || url !== undefined) {
				return {
					orm: "prisma",
					dir,
					configFile: file,
					...(envKey !== undefined ? { envKey } : { url: url as string })
				};
			}
			// Prisma 7 : l'URL quitte le schéma pour `prisma.config.ts`.
			const configFile = join(dir, "prisma.config.ts");
			const config = PRISMA_CONFIG_URL_RE.exec(readText(configFile) ?? "");
			const configKey = config?.[1] ?? config?.[2] ?? config?.[3];
			return {
				orm: "prisma",
				dir,
				configFile: configKey !== undefined ? configFile : file,
				...(configKey !== undefined ? { envKey: configKey } : {})
			};
		}
	}
	return undefined;
}

/** Un fichier `.prisma`, ou ceux d'un dossier (schéma en plusieurs fichiers). */
function prismaFiles(path: string): string[] {
	if (path.endsWith(".prisma")) return existsSync(path) ? [path] : [];
	try {
		return readdirSync(path)
			.filter((f) => f.endsWith(".prisma"))
			.sort()
			.map((f) => join(path, f));
	} catch {
		return [];
	}
}

function detectDoctrine(dir: string): OrmDetection | undefined {
	const composerFile = join(dir, "composer.json");
	const composer = readJson(composerFile);
	if (composer === undefined) return undefined;
	const packages = {
		...(composer.require as object | undefined),
		...(composer["require-dev"] as object | undefined)
	};
	if (!DOCTRINE_PACKAGES.some((p) => p in packages)) return undefined;
	const yamlFile = join(dir, "config", "packages", "doctrine.yaml");
	const envKey = DOCTRINE_URL_RE.exec(readText(yamlFile) ?? "")?.[1];
	return envKey !== undefined
		? { orm: "doctrine", dir, configFile: yamlFile, envKey }
		: // Doctrine sans Symfony lit `DATABASE_URL` par convention.
			{
				orm: "doctrine",
				dir,
				configFile: composerFile,
				envKey: "DATABASE_URL"
			};
}

function detectSequelize(dir: string): OrmDetection | undefined {
	const packageFile = join(dir, "package.json");
	const packageJson = readJson(packageFile);
	if (packageJson === undefined) return undefined;
	const deps = {
		...(packageJson.dependencies as object | undefined),
		...(packageJson.devDependencies as object | undefined)
	};
	if (!("sequelize" in deps)) return undefined;
	const configFile = sequelizeConfigFile(dir);
	const text = configFile !== undefined ? readText(configFile) : undefined;
	if (configFile === undefined || text === undefined) {
		return { orm: "sequelize", dir, configFile: packageFile };
	}
	const envKey = SEQUELIZE_ENV_RE.exec(text)?.[1];
	if (envKey !== undefined) {
		return { orm: "sequelize", dir, configFile, envKey };
	}
	const url = configFile.endsWith(".json") ? sequelizeUrl(text) : undefined;
	return {
		orm: "sequelize",
		dir,
		configFile,
		...(url !== undefined ? { url } : {})
	};
}

/** Fichier de config de Sequelize : celui de `.sequelizerc`, sinon l'usuel. */
function sequelizeConfigFile(dir: string): string | undefined {
	const rc = SEQUELIZERC_CONFIG_RE.exec(
		readText(join(dir, ".sequelizerc")) ?? ""
	);
	if (rc !== null) {
		const parts =
			rc[1] !== undefined
				? [...rc[1].matchAll(STRING_LITERAL_RE)].map((m) => m[1] as string)
				: [rc[2] as string];
		return join(dir, ...parts);
	}
	return SEQUELIZE_CONFIGS.map((f) => join(dir, f)).find((f) => existsSync(f));
}

/** Base de l'environnement `development` d'un `config.json` écrit en dur. */
function sequelizeUrl(text: string): string | undefined {
	let config: Record<string, Record<string, unknown>>;
	try {
		config = JSON.parse(text) as typeof config;
	} catch {
		return undefined;
	}
	const env = config.development ?? Object.values(config)[0];
	if (env === undefined || typeof env !== "object") return undefined;
	if (typeof env.url === "string") return env.url;
	const engine = SEQUELIZE_DIALECTS[String(env.dialect)];
	if (engine === undefined || typeof env.database !== "string")
		return undefined;
	return buildConnection(engine, {
		host: asString(env.host) ?? "localhost",
		port: Number(env.port) > 0 ? Number(env.port) : undefined,
		database: env.database,
		user: asString(env.username),
		password: asString(env.password),
		params: {}
	}).url;
}

function detectSeaOrm(dir: string): OrmDetection | undefined {
	const cargoFile = join(dir, "Cargo.toml");
	if (!SEA_ORM_RE.test(readText(cargoFile) ?? "")) return undefined;
	// sea-orm-cli et les migrations lisent `DATABASE_URL`.
	return { orm: "seaorm", dir, configFile: cargoFile, envKey: "DATABASE_URL" };
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function readText(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
}

function readJson(path: string): Record<string, unknown> | undefined {
	const text = readText(path);
	if (text === undefined) return undefined;
	try {
		const value = JSON.parse(text) as unknown;
		return value !== null && typeof value === "object"
			? (value as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}
