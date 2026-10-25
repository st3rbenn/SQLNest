/**
 * Applications d'un monorepo (ADR-038 S1) : membres déclarés — pnpm
 * (`pnpm-workspace.yaml`), npm et yarn (`workspaces`), Cargo — et
 * sous-dossiers qui portent un manifeste, un `.env`, Prisma ou compose.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { findComposeFile } from "./compose";

const SKIP_DIRS = new Set([
	"node_modules",
	"vendor",
	"target",
	"dist",
	"build",
	"coverage",
	"out",
	"tmp"
]);
const PROJECT_MARKERS = [
	"package.json",
	"composer.json",
	"Cargo.toml",
	".env",
	"prisma"
];
const MAX_DIRS = 40;
const PNPM_PACKAGES_RE = /^packages\s*:/;
const YAML_TOP_KEY_RE = /^\S/;
const YAML_LIST_ITEM_RE = /^\s*-\s*["']?([^"'#]+?)["']?\s*(?:#.*)?$/;
const CARGO_MEMBERS_RE = /\[workspace\][^[]*?members\s*=\s*\[([^\]]*)\]/;
const STRING_RE = /["']([^"']+)["']/g;
const DOT_SLASH_RE = /^\.\//;
const TRAILING_SLASHES_RE = /\/+$/;
const REGEX_SPECIALS_RE = /[.+?^${}()|[\]\\]/g;

/** Dossiers d'applications sous `root`, membres déclarés d'abord. */
export function workspaceDirs(root: string): string[] {
	const found = new Set<string>();
	for (const pattern of [
		...pnpmPatterns(root),
		...npmPatterns(root),
		...cargoPatterns(root)
	]) {
		for (const dir of expand(root, pattern)) found.add(dir);
	}
	for (const dir of childDirs(root)) {
		if (looksLikeProject(dir)) found.add(dir);
	}
	return [...found].slice(0, MAX_DIRS);
}

function pnpmPatterns(root: string): string[] {
	const text = readText(join(root, "pnpm-workspace.yaml"));
	if (text === undefined) return [];
	const patterns: string[] = [];
	let inPackages = false;
	for (const line of text.split("\n")) {
		if (PNPM_PACKAGES_RE.test(line)) {
			inPackages = true;
			continue;
		}
		if (!inPackages || line.trim() === "") continue;
		if (YAML_TOP_KEY_RE.test(line)) break;
		const item = YAML_LIST_ITEM_RE.exec(line)?.[1]?.trim();
		if (item !== undefined && !item.startsWith("!")) patterns.push(item);
	}
	return patterns;
}

function npmPatterns(root: string): string[] {
	let workspaces: unknown;
	try {
		workspaces = (
			JSON.parse(readText(join(root, "package.json")) ?? "{}") as {
				workspaces?: unknown;
			}
		).workspaces;
	} catch {
		return [];
	}
	const list = Array.isArray(workspaces)
		? workspaces
		: ((workspaces as { packages?: unknown } | undefined)?.packages ?? []);
	return Array.isArray(list)
		? list.filter(
				(p): p is string => typeof p === "string" && !p.startsWith("!")
			)
		: [];
}

function cargoPatterns(root: string): string[] {
	const members = CARGO_MEMBERS_RE.exec(
		readText(join(root, "Cargo.toml")) ?? ""
	);
	return members !== null
		? [...(members[1] as string).matchAll(STRING_RE)].map((m) => m[1] as string)
		: [];
}

/** Dossiers d'un motif : `backend`, `apps/*`, `packages/**`. */
function expand(root: string, pattern: string): string[] {
	const segments = pattern
		.replace(DOT_SLASH_RE, "")
		.replace(TRAILING_SLASHES_RE, "")
		.split("/")
		.filter((s) => s !== "" && s !== ".");
	let current = [root];
	for (const segment of segments) {
		const next: string[] = [];
		for (const dir of current) {
			if (segment === "**") {
				const children = childDirs(dir);
				next.push(dir, ...children, ...children.flatMap(childDirs));
			} else if (segment.includes("*")) {
				const re = new RegExp(
					`^${segment.replace(REGEX_SPECIALS_RE, "\\$&").replaceAll("*", ".*")}$`
				);
				next.push(...childDirs(dir).filter((d) => re.test(basename(d))));
			} else {
				const child = join(dir, segment);
				if (isDir(child)) next.push(child);
			}
		}
		current = [...new Set(next)];
	}
	return current.filter((d) => d !== root);
}

function childDirs(dir: string): string[] {
	try {
		return readdirSync(dir, { withFileTypes: true })
			.filter(
				(e) =>
					e.isDirectory() && !e.name.startsWith(".") && !SKIP_DIRS.has(e.name)
			)
			.map((e) => join(dir, e.name))
			.sort();
	} catch {
		return [];
	}
}

function looksLikeProject(dir: string): boolean {
	return (
		PROJECT_MARKERS.some((m) => existsSync(join(dir, m))) ||
		findComposeFile(dir) !== undefined
	);
}

function isDir(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function readText(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
}
