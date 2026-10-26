/**
 * Outil `prisma` du projet relié (ADR-037 D3) : le binaire du projet, jamais
 * une version téléchargée. Sa sortie est ramenée à ce qui peut partir dans la
 * réponse (D7) : ni chemin de la machine, ni extrait du modèle.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

export interface ToolRun {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

const BINARY = process.platform === "win32" ? "prisma.cmd" : "prisma";
// biome-ignore lint/suspicious/noControlCharactersInRegex: séquences de couleur ANSI
const ANSI_RE = /\x1b\[[0-9;]*m/g;
/** Extrait du modèle cité par une erreur : `41 |   champ …`, `   |`. */
const SNIPPET_RE = /^\s*\d*\s*\|/;
const NOISE_RE =
	/^(Prisma schema loaded from|Environment variables loaded from|Datasource "|Prisma CLI Version|\[Context:|warn The configuration property|DbError \{|$)/;

/** Binaire `prisma` du projet, ou d'un dossier parent (monorepo). */
export function findPrismaBinary(dir: string): string | undefined {
	let current = dir;
	for (;;) {
		const candidate = join(current, "node_modules", ".bin", BINARY);
		if (existsSync(candidate)) return candidate;
		const parent = dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

export function runTool(
	bin: string,
	args: readonly string[],
	options: {
		readonly cwd: string;
		readonly env: NodeJS.ProcessEnv;
		readonly timeoutMs: number;
	}
): Promise<ToolRun> {
	return new Promise((resolve, reject) => {
		const child = spawn(bin, [...args], {
			cwd: options.cwd,
			env: options.env,
			stdio: ["ignore", "pipe", "pipe"],
			// Un `.cmd` ne se lance que par le shell sous Windows.
			shell: process.platform === "win32"
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		const timer = setTimeout(() => child.kill("SIGTERM"), options.timeoutMs);
		child.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
		child.on("close", (code, signal) => {
			clearTimeout(timer);
			resolve({ code: code ?? (signal !== null ? 124 : 1), stdout, stderr });
		});
	});
}

/**
 * Sortie lisible d'un échec : couleurs, lignes de contexte et extraits du
 * modèle retirés, chemins du projet rendus relatifs.
 */
export function toolMessage(run: ToolRun, projectDir: string): string {
	const prefix = projectDir.endsWith("/") ? projectDir : `${projectDir}/`;
	return `${run.stderr}\n${run.stdout}`
		.replace(ANSI_RE, "")
		.split("\n")
		.map((line) => line.replaceAll(prefix, "").trimEnd())
		.filter((line) => !SNIPPET_RE.test(line) && !NOISE_RE.test(line.trim()))
		.join("\n")
		.trim();
}

/** SQL d'un `migrate diff --script`, sans les lignes de contexte de l'outil. */
export function toolScript(run: ToolRun): string {
	return run.stdout
		.replace(ANSI_RE, "")
		.split("\n")
		.filter((line) => !NOISE_RE.test(line.trim()) || line.trim() === "")
		.join("\n")
		.trim();
}
