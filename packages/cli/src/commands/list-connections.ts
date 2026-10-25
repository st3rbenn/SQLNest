/**
 * `sqlnest list-connections` — liste les DSN enregistrées dans
 * `~/.sqlnest/local-connections.toml` en cachant les credentials.
 *
 * Sortie : `<name>  <engine>  <host>:<port>/<database>`, plus la source
 * (référence à un `.env`) et le projet relié quand une entrée en a — jamais
 * le user ni le password. Politique alignée avec `describeConnectionForDiagnostics`
 * (règle sécu SQLNest : les creds ne sortent JAMAIS du fichier, même pour
 * l'user local qui les a saisis).
 */

import { defineCommand } from "../app/command";
import { ORM_LABELS } from "../orm/types";
import {
	describeLocation,
	parseConnectionString
} from "../services/connection-strings";
import {
	entryUrl,
	type LocalConnectionEntry,
	loadLocalConnections
} from "../services/local-connections";
import { tildify } from "../ui/paths";

export interface ListConnectionsOptions {
	readonly stdout: (line: string) => void;
}

export function listConnections(opts: ListConnectionsOptions): void {
	const file = loadLocalConnections();
	if (file === null || file.connections.length === 0) {
		opts.stdout(
			"Aucune connexion enregistrée.\nAjoute-en une : sqlnest add-connection"
		);
		return;
	}
	const rows = file.connections.map(summarize);
	// SOURCE et PROJET n'apparaissent que si une entrée les utilise.
	const columns: (readonly [string, (r: SummarizedConnection) => string])[] = [
		["NAME", (r) => r.name],
		["ENGINE", (r) => r.engine],
		["LOCATION", (r) => r.location]
	];
	if (rows.some((r) => r.source !== undefined)) {
		columns.push(["SOURCE", (r) => r.source ?? "url"]);
	}
	if (rows.some((r) => r.project !== undefined)) {
		columns.push(["PROJET", (r) => r.project ?? ""]);
	}
	const widths = columns.map(([title, cell]) =>
		Math.max(title.length, ...rows.map((r) => cell(r).length))
	);
	const line = (cells: readonly string[]) =>
		cells
			.map((cell, i) =>
				i === cells.length - 1 ? cell : pad(cell, widths[i] ?? 0)
			)
			.join("  ")
			.trimEnd();
	opts.stdout(line(columns.map(([title]) => title)));
	for (const r of rows) opts.stdout(line(columns.map(([, cell]) => cell(r))));
}

interface SummarizedConnection {
	readonly name: string;
	readonly engine: string;
	readonly location: string;
	readonly source?: string;
	readonly project?: string;
}

/**
 * `hôte:port/base` de l'entrée, sans utilisateur ni mot de passe. Une entrée
 * illisible (édition à la main, `.env` disparu) ne fait pas tomber la
 * commande : `<opaque>` ou la raison.
 */
function summarize(entry: LocalConnectionEntry): SummarizedConnection {
	let location = "<opaque>";
	let engine = "?";
	try {
		const parsed = parseConnectionString(entryUrl(entry));
		if (parsed !== undefined) {
			engine = parsed.engine;
			location = describeLocation(parsed);
		}
	} catch {
		location = "<.env illisible>";
	}
	return {
		name: entry.name,
		engine,
		location,
		...(entry.urlFrom !== undefined
			? { source: `${entry.urlFrom.key} · ${tildify(entry.urlFrom.file)}` }
			: {}),
		...(entry.project !== undefined
			? {
					project: `${ORM_LABELS[entry.project.orm]} · ${tildify(entry.project.path)}${
						entry.project.apply ? "" : " (sans apply)"
					}`
				}
			: {})
	};
}

function pad(s: string, width: number): string {
	return s.length >= width ? s : s + " ".repeat(width - s.length);
}

export const listConnectionsCommand = defineCommand({
	name: "list-connections",
	help: [
		["sqlnest list-connections", "Liste les connexions locales (sans secret)"]
	],
	run(args, ctx) {
		if (args.length > 0) {
			ctx.stderr(
				`sqlnest list-connections: aucun argument attendu, reçu « ${args.join(" ")} »`
			);
			return 2;
		}
		try {
			ctx.services.listConnections({ stdout: ctx.stdout });
			return 0;
		} catch (err) {
			ctx.stderr(`✗ ${(err as Error).message}`);
			return 1;
		}
	}
});
