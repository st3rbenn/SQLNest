/**
 * `sqlnest list-connections` — liste les DSN enregistrées dans
 * `~/.sqlnest/local-connections.toml` en cachant les credentials.
 *
 * Sortie : `<name>  <engine>  <host>:<port>/<database>` — jamais le user
 * ni le password. Politique alignée avec `describeConnectionForDiagnostics`
 * (règle sécu SQLNest : les creds ne sortent JAMAIS du fichier, même pour
 * l'user local qui les a saisis).
 */

import { loadLocalConnections } from "../local-connections";

export interface ListConnectionsOptions {
	readonly stdout: (line: string) => void;
}

export function listConnections(opts: ListConnectionsOptions): void {
	const file = loadLocalConnections();
	if (file === null || file.connections.length === 0) {
		opts.stdout(
			"Aucune connexion enregistrée.\nAjoute-en une : sqlnest add-connection --name <label>"
		);
		return;
	}
	// Aligne les 4 colonnes pour lisibilité — largeur du name + engine
	// dépendent des entrées. Fallback minimums pour un affichage propre
	// même avec une seule entrée courte.
	const rows = file.connections.map((c) => summarizeUrl(c.name, c.url));
	const nameW = Math.max(4, ...rows.map((r) => r.name.length));
	const engineW = Math.max(6, ...rows.map((r) => r.engine.length));
	opts.stdout(`${pad("NAME", nameW)}  ${pad("ENGINE", engineW)}  LOCATION`);
	for (const r of rows) {
		opts.stdout(`${pad(r.name, nameW)}  ${pad(r.engine, engineW)}  ${r.location}`);
	}
}

interface SummarizedConnection {
	readonly name: string;
	readonly engine: string;
	readonly location: string;
}

/**
 * Extrait `host:port/database` de la DSN sans exposer user/password. Sur
 * DSN invalide, retombe sur `<opaque>` (jamais throw — cette command ne
 * doit pas mourir sur une entrée mal formée qu'un edit manuel aurait
 * introduite).
 */
function summarizeUrl(name: string, url: string): SummarizedConnection {
	try {
		const u = new URL(url);
		const engine = u.protocol.replace(/:$/, "");
		const host = u.hostname;
		const port = u.port || defaultPortOf(engine);
		// pathname = "/dbname" pour PG/Mongo ; le "/" en tête reste retiré.
		const database = u.pathname.replace(/^\//, "") || "<unset>";
		return { name, engine, location: `${host}:${port}/${database}` };
	} catch {
		return { name, engine: "?", location: "<opaque>" };
	}
}

function defaultPortOf(engine: string): string {
	if (engine === "postgres" || engine === "postgresql") return "5432";
	if (engine === "mongodb" || engine === "mongodb+srv") return "27017";
	return "?";
}

function pad(s: string, width: number): string {
	return s.length >= width ? s : s + " ".repeat(width - s.length);
}
