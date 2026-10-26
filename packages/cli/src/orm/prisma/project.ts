/**
 * Projet Prisma relié : où sont le schéma et les migrations, comment nommer
 * une migration, et quelle base l'outil vise — celle de la connexion, passée
 * par les variables du `datasource`.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { DDLPlan } from "@sqlnest/snql";
import {
	connectionParts,
	DEFAULT_PORT,
	type ParsedConnection
} from "../../services/connection-strings";
import type { OrmDetection } from "../detect";

export interface PrismaSchemaLocation {
	/** Argument `--schema` : le fichier, ou le dossier d'un schéma en plusieurs fichiers. */
	readonly arg: string;
	/** Fichiers du schéma, dans l'ordre où Prisma les lit. */
	readonly files: readonly string[];
	/** Dossier des migrations : à côté du fichier qui porte le `datasource`. */
	readonly migrations: string;
	/** Fichier qui porte le `datasource`. */
	readonly datasourceFile: string;
}

const CONFIG_SCHEMA_RE = /\bschema\s*:\s*["'`]([^"'`]+)["'`]/;
const DATASOURCE_RE = /datasource\s+\w+\s*\{([^}]*)\}/;
const ENV_KEY_RE = (property: string): RegExp =>
	new RegExp(
		`(?:^|\\n)\\s*${property}\\s*=\\s*env\\(\\s*"([A-Za-z_][A-Za-z0-9_]*)"\\s*\\)`
	);
const PROVIDER_RE = /(?:^|\n)\s*provider\s*=\s*"([^"]+)"/;
const STAMP_RE = /^\d{14}$/;
const SLUG_UNSAFE_RE = /[^a-z0-9]+/g;
const EDGE_UNDERSCORES_RE = /^_+|_+$/g;
const JDBC_SPECIAL_RE = /[;={}]/;
const MAX_SLUG = 60;

export function prismaSchemaLocation(
	detection: OrmDetection
): PrismaSchemaLocation | undefined {
	const datasourceFile = detection.configFile.endsWith(".prisma")
		? detection.configFile
		: configuredSchema(detection);
	if (datasourceFile === undefined) return undefined;
	const dir = dirname(datasourceFile);
	// `prisma/schema/` : schéma en plusieurs fichiers (prismaSchemaFolder).
	const folder = basename(dir) === "schema";
	return {
		arg: folder ? dir : datasourceFile,
		files: folder ? prismaFiles(dir) : [datasourceFile],
		migrations: join(dir, "migrations"),
		datasourceFile
	};
}

/** Prisma 7 : le schéma désigné par `prisma.config.ts`, sinon l'emplacement par défaut. */
function configuredSchema(detection: OrmDetection): string | undefined {
	const config = readText(detection.configFile);
	const declared =
		config !== undefined ? CONFIG_SCHEMA_RE.exec(config)?.[1] : undefined;
	const candidates = [
		...(declared !== undefined ? [join(detection.dir, declared)] : []),
		join(detection.dir, "prisma", "schema.prisma"),
		join(detection.dir, "prisma", "schema")
	];
	for (const candidate of candidates) {
		const files = candidate.endsWith(".prisma")
			? existsSync(candidate)
				? [candidate]
				: []
			: prismaFiles(candidate);
		const withDatasource = files.find((f) =>
			DATASOURCE_RE.test(readText(f) ?? "")
		);
		if (withDatasource !== undefined) return withDatasource;
	}
	return undefined;
}

/** `.prisma` d'un dossier et de ses sous-dossiers, triés. */
function prismaFiles(dir: string): string[] {
	try {
		return readdirSync(dir)
			.sort()
			.flatMap((entry) => {
				const path = join(dir, entry);
				if (statSync(path).isDirectory()) return prismaFiles(path);
				return entry.endsWith(".prisma") ? [path] : [];
			});
	} catch {
		return [];
	}
}

/** Variables d'environnement du `datasource` : `url`, `directUrl`. */
export function datasourceEnvKeys(schemaText: string): string[] {
	const body = DATASOURCE_RE.exec(schemaText)?.[1];
	if (body === undefined) return [];
	return ["url", "directUrl"].flatMap((property) => {
		const key = ENV_KEY_RE(property).exec(body)?.[1];
		return key !== undefined ? [key] : [];
	});
}

/** Fournisseur du `datasource`. */
export function datasourceProvider(schemaText: string): string | undefined {
	const body = DATASOURCE_RE.exec(schemaText)?.[1];
	return body !== undefined ? PROVIDER_RE.exec(body)?.[1] : undefined;
}

/**
 * URL d'une base au format de Prisma : celle de l'engine sous PostgreSQL ;
 * sous SQL Server, `sqlserver://hôte:port;database=…;user=…` (valeurs
 * spéciales entre accolades).
 */
export function prismaDatabaseUrl(c: ParsedConnection): string {
	if (c.engine !== "mssql") return c.url;
	const parts = connectionParts(c);
	const properties: [string, string][] = [
		...(parts.database !== undefined
			? [["database", parts.database] as [string, string]]
			: []),
		...(parts.user !== undefined
			? [["user", parts.user] as [string, string]]
			: []),
		...(parts.password !== undefined
			? [["password", parts.password] as [string, string]]
			: []),
		...Object.entries(parts.params)
	];
	const braced = (value: string): string =>
		JDBC_SPECIAL_RE.test(value) ? `{${value.replaceAll("}", "}}")}}` : value;
	return `sqlserver://${parts.host}:${parts.port ?? DEFAULT_PORT.mssql};${properties
		.map(([key, value]) => `${key}=${braced(value)}`)
		.join(";")}`;
}

/**
 * Nom d'une migration, comme `prisma migrate dev` : horodatage UTC puis ce que
 * fait le changement. L'horodatage passe après celui de la dernière migration.
 */
export function migrationName(
	plan: DDLPlan,
	existing: readonly string[],
	now: Date
): string {
	const slug = migrationSlug(plan)
		.toLowerCase()
		.replace(SLUG_UNSAFE_RE, "_")
		.replace(EDGE_UNDERSCORES_RE, "")
		.slice(0, MAX_SLUG);
	const last = existing
		.map((name) => name.slice(0, 14))
		.filter((stamp) => STAMP_RE.test(stamp))
		.sort()
		.at(-1);
	let stamp = timestamp(now);
	if (last !== undefined && stamp <= last) {
		stamp = timestamp(new Date(fromTimestamp(last).getTime() + 1000));
	}
	return `${stamp}_${slug}`;
}

function migrationSlug(plan: DDLPlan): string {
	switch (plan.kind) {
		case "create-table":
			return `create_${plan.target}`;
		case "drop-table":
			return `drop_${plan.target}`;
		case "add-column":
			return `add_${plan.target}_${plan.column.name}`;
		case "drop-column":
			return `drop_${plan.target}_${plan.column}`;
		case "rename-column":
			return `rename_${plan.target}_${plan.column}_${plan.newName}`;
		case "alter-column":
			return `alter_${plan.target}_${plan.column}_${plan.action.kind}`;
		case "add-index":
			return `index_${plan.target}_${plan.fields.join("_")}`;
		case "add-unique-index":
			return `unique_${plan.target}_${plan.fields.join("_")}`;
		case "drop-index":
			return `drop_${plan.name}`;
		case "add-ref":
			return `ref_${plan.target}_${plan.ref.fromColumn}`;
		case "drop-ref":
			return `drop_${plan.name}`;
		case "create-enum":
			return `enum_${plan.name}`;
		case "add-enum-member":
			return `enum_${plan.name}_${plan.member}`;
		case "drop-enum":
			return `drop_enum_${plan.name}`;
	}
}

function timestamp(date: Date): string {
	return date.toISOString().replace(/\D/g, "").slice(0, 14);
}

function fromTimestamp(stamp: string): Date {
	return new Date(
		`${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(8, 10)}:${stamp.slice(10, 12)}:${stamp.slice(12, 14)}Z`
	);
}

// ─── Schéma en plusieurs fichiers ──────────────────────────────────────

const FILE_MARK = (file: string): string => `// ⟪sqlnest-file ${file}⟫`;
const FILE_MARK_RE = /^\/\/ ⟪sqlnest-file (.+)⟫$/;

/**
 * Fichiers du schéma en un texte, chacun précédé d'une ligne de repère ; le
 * patcheur, qui ne touche que les blocs, la laisse en place.
 */
export function joinSchemaFiles(
	files: readonly { readonly path: string; readonly text: string }[]
): string {
	if (files.length === 1) return (files[0] as { text: string }).text;
	return files.map((f) => `${FILE_MARK(f.path)}\n${f.text}`).join("\n");
}

/** Le texte patché, rendu à chaque fichier. */
export function splitSchemaFiles(
	text: string,
	paths: readonly string[]
): Map<string, string> {
	if (paths.length === 1) return new Map([[paths[0] as string, text]]);
	const out = new Map<string, string>();
	let current: string | undefined;
	let lines: string[] = [];
	const flush = (): void => {
		if (current !== undefined) out.set(current, lines.join("\n"));
	};
	for (const line of text.split("\n")) {
		const mark = FILE_MARK_RE.exec(line);
		if (mark !== null) {
			flush();
			current = mark[1] as string;
			lines = [];
			continue;
		}
		lines.push(line);
	}
	flush();
	return out;
}

function readText(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
}
