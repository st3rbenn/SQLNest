import { homedir } from "node:os";

/** Chemin affiché, le dossier personnel abrégé en `~`. */
export function tildify(path: string): string {
	const home = homedir();
	return path === home || path.startsWith(`${home}/`)
		? `~${path.slice(home.length)}`
		: path;
}
