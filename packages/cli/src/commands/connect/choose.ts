/**
 * Connexion que `sqlnest connect` sert (ADR-038 S6).
 *
 *   1. `--connection <nom>` explicite (validé contre le fichier).
 *   2. Dans un projet relié : sa connexion, sans menu.
 *   3. Projet non relié dont la base est détectée (terminal) : relier la
 *      connexion qui la vise, ou la créer puis relier.
 *   4. Aucune connexion : la découverte d'`add-connection` (terminal), sinon
 *      `null` — le tunnel lit alors `SQLNEST_PG_URL`.
 *   5. Une seule : celle-ci. Plusieurs : un menu présenté comme celui
 *      d'`add-connection` (moteur, base sans secret, projet, serveur arrêté,
 *      état du tunnel) ; sans terminal, une liste numérotée.
 */

import { sep } from "node:path";
import type { OrmDetection } from "../../orm/detect";
import { ORM_LABELS } from "../../orm/types";
import type { TunnelEntry } from "../../services/config";
import {
	connectionIdentity,
	describeConnection,
	describeLocation,
	ENGINE_LABELS,
	type ParsedConnection,
	parseConnectionString
} from "../../services/connection-strings";
import {
	configuredIdentities,
	type DiscoveredDatabase,
	type Discovery,
	isInside,
	isPortOpen,
	serverFor
} from "../../services/discovery";
import { projectDirs } from "../../services/discovery/project";
import {
	entryUrl,
	type LocalConnectionEntry,
	loadLocalConnections
} from "../../services/local-connections";
import { shortPath, tildify } from "../../ui/paths";
import {
	confirmDefaultYes,
	type Prompter,
	type SelectEntry
} from "../../ui/prompts";
import { alignCells, columnWidths } from "../../ui/table";

export interface ChooseConnectionOptions {
	readonly explicit?: string;
	readonly cwd: string;
	readonly home: string;
	/** Terminal : menus, découverte, propositions. */
	readonly interactive: boolean;
	readonly tunnels: readonly TunnelEntry[];
	readonly discover: (cwd: string) => Promise<Discovery>;
	/** Crée une connexion — base présélectionnée, sinon menu de découverte ; rend son nom. */
	readonly addConnection: (database?: DiscoveredDatabase) => Promise<string>;
	/** Relie le projet d'un ORM à une connexion. */
	readonly link: (name: string, detection: OrmDetection) => Promise<void>;
	readonly prompter: Prompter;
	readonly stdout: (line: string) => void;
	readonly stderr: (line: string) => void;
}

const ADD = Symbol("ajouter");

export async function chooseConnection(
	opts: ChooseConnectionOptions
): Promise<string | null> {
	const entries = loadLocalConnections()?.connections ?? [];
	if (opts.explicit !== undefined)
		return explicitConnection(opts.explicit, entries);

	const root = projectDirs(opts.cwd, opts.home)?.root;
	const linked = linkedHere(entries, root, opts.cwd);
	if (linked !== undefined) {
		const project = linked.project as NonNullable<
			LocalConnectionEntry["project"]
		>;
		opts.stdout(
			`Connexion : ${linked.name} — projet relié (${ORM_LABELS[project.orm]} · ${shortPath(project.path, root)})`
		);
		return linked.name;
	}
	if (!opts.interactive) {
		if (entries.length <= 1) return entries[0]?.name ?? null;
		return numberedChoice(opts, entries);
	}

	const discovery = await opts.discover(opts.cwd);
	const offered = await offerProject(opts, entries, discovery);
	if (offered !== undefined) return offered;
	if (entries.length === 0) {
		opts.stdout("Aucune connexion enregistrée — choisis une base :");
		return opts.addConnection();
	}
	if (entries.length === 1) return (entries[0] as LocalConnectionEntry).name;
	const choice = await opts.prompter.select<string | typeof ADD>({
		message: "Connexion à servir",
		choices: await connectionChoices(entries, discovery, opts.tunnels, root)
	});
	return choice === ADD ? opts.addConnection() : choice;
}

function explicitConnection(
	name: string,
	entries: readonly LocalConnectionEntry[]
): string {
	if (entries.length === 0) {
		throw new Error(
			`--connection ${name} : aucune connexion locale.\n` +
				`Ajoute-en une : sqlnest add-connection --name ${name}`
		);
	}
	if (!entries.some((c) => c.name === name)) {
		const names = entries.map((c) => c.name).join(", ");
		throw new Error(
			`--connection ${name} : aucune connexion « ${name} » ` +
				`dans local-connections.toml. Connues : ${names}`
		);
	}
	return name;
}

/**
 * Connexion du projet relié où l'on se trouve : celle dont le projet
 * contient le dossier courant, sinon la seule reliée à un dossier du dépôt.
 */
function linkedHere(
	entries: readonly LocalConnectionEntry[],
	root: string | undefined,
	cwd: string
): LocalConnectionEntry | undefined {
	if (root === undefined) return undefined;
	const inRepo = entries.filter(
		(e) => e.project !== undefined && isInside(e.project.path, root)
	);
	const containing = inRepo.filter((e) =>
		isInside(
			cwd,
			(e.project as NonNullable<LocalConnectionEntry["project"]>).path
		)
	);
	if (containing.length === 1) return containing[0];
	return inRepo.length === 1 && containing.length === 0 ? inRepo[0] : undefined;
}

/**
 * Projet non relié dont la base est détectée : relier la connexion qui la
 * vise, ou la créer puis relier (ADR-038 S6). `undefined` si rien n'est
 * proposé ou si l'utilisateur refuse.
 */
async function offerProject(
	opts: ChooseConnectionOptions,
	entries: readonly LocalConnectionEntry[],
	discovery: Discovery
): Promise<string | undefined> {
	const database = discovery.databases.find(
		(d) =>
			d.orm !== undefined &&
			!entries.some((e) => e.project?.path === d.orm?.dir)
	);
	const detection = database?.orm;
	if (database === undefined || detection === undefined) return undefined;
	const project = `${ORM_LABELS[detection.orm]} (${shortPath(detection.dir, discovery.root)})`;
	const described = describeConnection(database.connection);
	const existing = configuredIdentities(entries).get(
		connectionIdentity(database.connection)
	);
	if (existing !== undefined) {
		if (
			!(await confirmDefaultYes(
				opts.prompter,
				`Le projet ${project} lit ${described}, celle de « ${existing} ». Relier le projet ? [Y/n] `
			))
		) {
			return undefined;
		}
		await opts.link(existing, detection);
		return existing;
	}
	if (
		!(await confirmDefaultYes(
			opts.prompter,
			`Le projet ${project} lit ${described}. Créer la connexion et relier le projet ? [Y/n] `
		))
	) {
		return undefined;
	}
	const name = await opts.addConnection(database);
	await opts.link(name, detection);
	return name;
}

/** Lignes du menu : connexions du projet, autres connexions, ajout. */
async function connectionChoices(
	entries: readonly LocalConnectionEntry[],
	discovery: Discovery,
	tunnels: readonly TunnelEntry[],
	root: string | undefined
): Promise<SelectEntry<string | typeof ADD>[]> {
	const projectIdentities = new Set(
		discovery.databases.map((d) => connectionIdentity(d.connection))
	);
	const rows = await Promise.all(
		entries.map(async (entry) => {
			let connection: ParsedConnection | undefined;
			let unreadable: string | undefined;
			try {
				connection = parseConnectionString(entryUrl(entry));
			} catch (err) {
				unreadable = (err as Error).message;
			}
			const server =
				connection !== undefined ? serverFor(connection, discovery) : undefined;
			const stopped =
				server !== undefined &&
				!server.running &&
				!(await isPortOpen(server.host, server.port));
			const status = describeTunnelStatus(tunnels, entry.name, Date.now());
			return {
				entry,
				inProject:
					(entry.project !== undefined &&
						root !== undefined &&
						isInside(entry.project.path, root)) ||
					(connection !== undefined &&
						projectIdentities.has(connectionIdentity(connection))),
				unreadable,
				cells: [
					entry.name,
					entry.project !== undefined
						? `${ORM_LABELS[entry.project.orm]} · ${projectLabel(entry.project.path, root)}`
						: "",
					connection !== undefined
						? `${ENGINE_LABELS[connection.engine]} · ${describeLocation(connection)}${stopped ? " (arrêté)" : ""}`
						: "",
					status !== null ? `tunnel ${status}` : ""
				]
			};
		})
	);
	const widths = columnWidths(rows.map((r) => r.cells));
	const toChoice = (
		row: (typeof rows)[number]
	): SelectEntry<string | typeof ADD> => ({
		value: row.entry.name,
		label: alignCells(row.cells, widths),
		short: row.entry.name,
		description: describeEntry(row.entry),
		...(row.unreadable !== undefined ? { disabled: row.unreadable } : {})
	});
	const here = rows.filter((r) => r.inProject);
	const others = rows.filter((r) => !r.inProject);
	return [
		...(here.length > 0
			? [
					{ separator: `── ${root !== undefined ? tildify(root) : "Projet"}` },
					...here.map(toChoice)
				]
			: []),
		...(here.length > 0 && others.length > 0
			? [{ separator: "── Autres connexions" }]
			: []),
		...others.map(toChoice),
		{ separator: "──" },
		{ value: ADD, label: "Ajouter une connexion…" }
	];
}

/** Dossier du projet : relatif au dépôt courant, sinon ses deux derniers niveaux. */
function projectLabel(path: string, root: string | undefined): string {
	if (root !== undefined && isInside(path, root)) return shortPath(path, root);
	return path.split(sep).slice(-2).join(sep);
}

/** Sous le menu : chemin du projet relié, `.env` relu. */
function describeEntry(entry: LocalConnectionEntry): string {
	return [
		entry.project !== undefined ? tildify(entry.project.path) : undefined,
		entry.urlFrom !== undefined
			? `${entry.urlFrom.key} · ${tildify(entry.urlFrom.file)}`
			: undefined
	]
		.filter((part) => part !== undefined)
		.join(" · ");
}

/** Sans terminal : liste numérotée, réponse lue sur l'entrée. */
async function numberedChoice(
	opts: ChooseConnectionOptions,
	entries: readonly LocalConnectionEntry[]
): Promise<string> {
	const decorate = (name: string): string => {
		const status = describeTunnelStatus(opts.tunnels, name, Date.now());
		return status === null ? name : `${name} (tunnel ${status})`;
	};
	opts.stdout("▲ Plusieurs connexions locales :");
	entries.forEach((entry, i) => {
		opts.stdout(`  ${i + 1}) ${decorate(entry.name)}`);
	});
	for (;;) {
		const raw = (await opts.prompter.line("Connexion à servir [1] : ")).trim();
		const idx = raw === "" ? 1 : Number.parseInt(raw, 10);
		const entry = Number.isInteger(idx) ? entries[idx - 1] : undefined;
		if (entry !== undefined) return entry.name;
		opts.stderr(
			`Réponse invalide — tape un numéro entre 1 et ${entries.length}.`
		);
	}
}

/**
 * Cherche le tunnel le plus récent pour une connexion locale donnée dans la
 * config et retourne un status human-readable :
 *   - `"valide 20j"` — token pas expiré (matching strict par `connection_name`).
 *   - `"expiré il y a 3j"` — token expiré.
 *   - `null` — aucun tunnel taggé pour cette connexion (jamais paired ou entry
 *     legacy sans `connection_name`).
 */
export function describeTunnelStatus(
	tunnels: readonly TunnelEntry[],
	connectionName: string,
	nowMs: number
): string | null {
	// Le plus récent d'abord — reflète le dernier pair effectué.
	for (let i = tunnels.length - 1; i >= 0; i--) {
		const t = tunnels[i];
		if (t?.connection_name !== connectionName) continue;
		const expiresMs = Date.parse(t.expires_at);
		if (Number.isNaN(expiresMs)) return null;
		const delta = expiresMs - nowMs;
		if (delta > 0) return `valide ${humanDuration(delta)}`;
		return `expiré il y a ${humanDuration(-delta)}`;
	}
	return null;
}

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

function humanDuration(ms: number): string {
	if (ms < MINUTE_MS) return "moins d'une minute";
	if (ms < HOUR_MS) return `${Math.floor(ms / MINUTE_MS)}min`;
	if (ms < DAY_MS) return `${Math.floor(ms / HOUR_MS)}h`;
	return `${Math.floor(ms / DAY_MS)}j`;
}
