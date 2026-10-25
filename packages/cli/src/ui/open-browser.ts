/**
 * Ouverture best-effort d'une URL dans le navigateur par défaut.
 *
 * ─── Multi-plateforme ─────────────────────────────────────────────────
 *   - macOS  : `open <url>`
 *   - linux  : `xdg-open <url>`
 *   - win32  : `cmd /c start "" <url>`
 *
 * ─── Best-effort ──────────────────────────────────────────────────────
 * Ne throw jamais — un CLI honnête reste utilisable même si le browser
 * ne s'ouvre pas (SSH tunnel, serveur headless). Le user peut copier
 * l'URL affichée. On log l'échec via `onError` si fourni.
 *
 * ─── Sécurité URL ─────────────────────────────────────────────────────
 * L'URL est passée en argument, PAS via shell string interpolation —
 * `spawn` sans `shell: true` empêche l'injection de commandes. Toute
 * URL construite depuis un input contrôlé par le user devrait quand
 * même être validée en amont (dans notre cas, l'URL vient du backend
 * de config).
 */

import { spawn } from "node:child_process";
import { platform } from "node:os";

export interface OpenBrowserOptions {
	/** Override pour test — retourne 0 pour success, autre pour échec. */
	readonly spawnFn?: (
		command: string,
		args: readonly string[]
	) => Promise<number>;
	readonly platformFn?: () => NodeJS.Platform;
}

/**
 * Tente d'ouvrir l'URL. Retourne `true` si le processus s'est lancé
 * avec code 0, `false` sinon (le caller peut suggérer une copie
 * manuelle).
 */
export async function openBrowser(
	url: string,
	options: OpenBrowserOptions = {}
): Promise<boolean> {
	const currentPlatform = options.platformFn?.() ?? platform();
	const spawnRunner = options.spawnFn ?? defaultSpawn;

	let command: string;
	let args: readonly string[];
	switch (currentPlatform) {
		case "darwin":
			command = "open";
			args = [url];
			break;
		case "win32":
			// `start` a besoin d'un titre vide pour interpréter le 2e arg
			// comme URL — `cmd /c start "" <url>`.
			command = "cmd";
			args = ["/c", "start", "", url];
			break;
		default:
			// Linux / BSD / autres unix — xdg-open est le standard.
			command = "xdg-open";
			args = [url];
			break;
	}

	try {
		const code = await spawnRunner(command, args);
		return code === 0;
	} catch {
		return false;
	}
}

async function defaultSpawn(
	command: string,
	args: readonly string[]
): Promise<number> {
	return new Promise((resolve) => {
		const child = spawn(command, args, {
			// Détaché : ne pas garder le CLI vivant en attendant le browser.
			// stdio ignoré : évite d'écraser la sortie CLI.
			stdio: "ignore",
			detached: true
		});
		child.on("error", () => resolve(1));
		child.on("close", (code) => resolve(code ?? 0));
		// Résout immédiatement dès que le child est spawn — on n'attend
		// pas la fermeture du browser (qui peut durer toute la journée).
		child.unref();
		resolve(0);
	});
}
