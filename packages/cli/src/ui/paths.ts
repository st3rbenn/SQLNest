import { homedir } from "node:os";
import { relative } from "node:path";

/** Chemin affiché, le dossier personnel abrégé en `~`. */
export function tildify(path: string): string {
	const home = homedir();
	return path === home || path.startsWith(`${home}/`)
		? `~${path.slice(home.length)}`
		: path;
}

/** Chemin relatif à la racine du projet, sinon abrégé en `~`. */
export function shortPath(path: string, root: string | undefined): string {
	if (root === undefined) return tildify(path);
	const rel = relative(root, path);
	return rel === "" ? "." : rel.startsWith("..") ? tildify(path) : rel;
}
