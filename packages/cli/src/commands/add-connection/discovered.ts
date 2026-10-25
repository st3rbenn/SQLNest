/**
 * Choix d'une base découverte (ADR-038 S1, S2) : bases et serveurs du projet
 * courant, autres serveurs Docker dont les bases se listent en direct, chaîne
 * collée, saisie guidée. Une base déjà configurée reste visible, grisée ; un
 * serveur arrêté est démarré si l'utilisateur le veut.
 */

import { ORM_LABELS } from "../../orm/types";
import {
	connectionIdentity,
	describeConnection,
	ENGINE_LABELS,
	type ParsedConnection,
	parseConnectionString
} from "../../services/connection-strings";
import {
	type DiscoveredDatabase,
	type DiscoveredServer,
	type DiscoveredSource,
	type Discovery,
	serverConnection
} from "../../services/discovery";
import type { LocalConnectionUrlRef } from "../../services/local-connections";
import { shortPath, tildify } from "../../ui/paths";
import {
	confirmDefaultYes,
	type Prompter,
	type SelectEntry
} from "../../ui/prompts";
import { alignCells, columnWidths } from "../../ui/table";
import {
	AddConnectionError,
	describeFailure,
	unrecognizedConnection
} from "./errors";

/** Ce qui sera testé puis enregistré : une URL, ou une référence au `.env`. */
export interface ConnectionTarget {
	readonly url: string;
	readonly urlFrom?: LocalConnectionUrlRef;
	/** Base découverte choisie : son ORM permet de relier le projet. */
	readonly database?: DiscoveredDatabase;
}

export type DiscoveryPick =
	| { readonly kind: "database"; readonly database: DiscoveredDatabase }
	| { readonly kind: "server"; readonly server: DiscoveredServer }
	| { readonly kind: "paste" }
	| { readonly kind: "manual" };

export interface ChooseOptions {
	readonly prompter: Prompter;
	readonly stdout: (line: string) => void;
	/** Bases d'un serveur, lues en direct ; absent : nom de base demandé. */
	readonly listDatabases?: (url: string) => Promise<readonly string[]>;
	/** Démarre un serveur arrêté et attend que `url` réponde ; absent : jamais proposé. */
	readonly startServer?: (
		server: DiscoveredServer,
		url: string
	) => Promise<void>;
	readonly manual: () => Promise<string>;
}

export async function chooseDiscovered(
	opts: ChooseOptions,
	discovery: Discovery,
	configured: ReadonlyMap<string, string>
): Promise<ConnectionTarget> {
	if (
		discovery.databases.length === 0 &&
		discovery.projectServers.length === 0 &&
		discovery.servers.length === 0
	) {
		opts.stdout("Aucune base trouvée dans ce dossier ni dans Docker.");
	}
	const pick = await opts.prompter.select({
		message: "Base à ajouter",
		choices: discoveryChoices(discovery, configured)
	});
	switch (pick.kind) {
		case "database":
			return targetOfDatabase(opts, pick.database);
		case "server":
			return {
				url: (await chooseServerDatabase(opts, pick.server, configured)).url
			};
		case "paste": {
			const parsed = parseConnectionString(
				await opts.prompter.password("Chaîne de connexion : ")
			);
			if (parsed === undefined) throw unrecognizedConnection();
			opts.stdout(
				`${ENGINE_LABELS[parsed.engine]} · ${describeConnection(parsed)}`
			);
			return { url: parsed.url };
		}
		case "manual":
			return { url: await opts.manual() };
	}
}

/** Lignes du menu : projet, Docker, puis les deux saisies. */
export function discoveryChoices(
	discovery: Discovery,
	configured: ReadonlyMap<string, string>
): SelectEntry<DiscoveryPick>[] {
	const root = discovery.root;
	const entries: SelectEntry<DiscoveryPick>[] = [];
	if (
		discovery.databases.length > 0 ||
		discovery.projectServers.length > 0 ||
		discovery.unresolved.length > 0
	) {
		entries.push({
			separator: `── ${root !== undefined ? tildify(root) : "Projet"}`
		});
		const rows = discovery.databases.map((database) => {
			const c = database.connection;
			return {
				database,
				cells: [
					c.database ?? c.host,
					database.orm !== undefined
						? `${ORM_LABELS[database.orm.orm]} · ${shortPath(database.orm.dir, root)}`
						: "",
					`${ENGINE_LABELS[c.engine]} · ${describeServerOf(c)}${stoppedMark(database.server)}`
				]
			};
		});
		// Bases et serveurs du projet partagent leur première colonne.
		const nameWidth = Math.max(
			0,
			...rows.map((r) => (r.cells[0] as string).length),
			...discovery.projectServers.map((s) => s.name.length)
		);
		const widths = columnWidths(rows.map((r) => r.cells));
		widths[0] = nameWidth;
		for (const { database, cells } of rows) {
			const already = configured.get(connectionIdentity(database.connection));
			const container =
				database.server !== undefined
					? ` · conteneur ${database.server.name}`
					: "";
			entries.push({
				value: { kind: "database", database },
				label: alignCells(cells, widths),
				short: describeConnection(database.connection),
				description: `${describeSource(database.source, root)}${container}`,
				...(already !== undefined
					? { disabled: `déjà configurée : ${already}` }
					: {})
			});
		}
		entries.push(...serverChoices(discovery.projectServers, nameWidth));
		for (const { orm, reason } of discovery.unresolved) {
			entries.push({
				separator: `  ${ORM_LABELS[orm.orm]} · ${shortPath(orm.dir, root)} — ${reason}`
			});
		}
	}
	if (discovery.servers.length > 0) {
		entries.push(
			{ separator: "── Docker" },
			...serverChoices(discovery.servers)
		);
	}
	entries.push(
		{ separator: "──" },
		{
			value: { kind: "paste" },
			label: "Coller une chaîne de connexion",
			description: "URL, JDBC, ADO.NET ou libpq"
		},
		{ value: { kind: "manual" }, label: "Saisir à la main" }
	);
	return entries;
}

function serverChoices(
	servers: readonly DiscoveredServer[],
	nameWidth = 0
): SelectEntry<DiscoveryPick>[] {
	const rows = servers.map((server) => ({
		server,
		cells: [
			server.name,
			`${ENGINE_LABELS[server.engine]} · ${server.host}:${server.port}${stoppedMark(server)}`
		]
	}));
	const widths = columnWidths(rows.map((r) => r.cells));
	widths[0] = Math.max(widths[0] ?? 0, nameWidth);
	return rows.map(({ server, cells }) => ({
		value: { kind: "server", server },
		label: alignCells(cells, widths),
		short: server.name,
		description:
			server.compose !== undefined
				? `${server.image} · compose ${server.compose.project}/${server.compose.service}`
				: server.image
	}));
}

function stoppedMark(server: DiscoveredServer | undefined): string {
	return server !== undefined && !server.running ? " (arrêté)" : "";
}

/** Une base découverte, son serveur démarré s'il est arrêté et que l'utilisateur le veut. */
export async function targetOfDatabase(
	opts: Pick<ChooseOptions, "prompter" | "stdout" | "startServer">,
	database: DiscoveredDatabase
): Promise<ConnectionTarget> {
	const { connection, server, urlFrom } = database;
	if (server !== undefined && !server.running) {
		await ensureRunning(opts, server, connection.url);
	}
	return {
		url: connection.url,
		...(urlFrom !== undefined ? { urlFrom } : {}),
		database
	};
}

/** Propose de démarrer un serveur arrêté ; un échec n'arrête pas la suite. */
export async function ensureRunning(
	opts: Pick<ChooseOptions, "prompter" | "stdout" | "startServer">,
	server: DiscoveredServer,
	url: string
): Promise<void> {
	if (opts.startServer === undefined) return;
	if (
		!(await confirmDefaultYes(
			opts.prompter,
			`« ${server.name} » est arrêté. Le démarrer ? [Y/n] `
		))
	) {
		return;
	}
	try {
		await opts.startServer(server, url);
		opts.stdout(`✓ ${server.name} démarré`);
	} catch (err) {
		opts.stdout(
			`✗ Démarrage de ${server.name} impossible : ${describeFailure(err)}`
		);
	}
}

/** Base d'un serveur : listée en direct, sinon demandée. */
async function chooseServerDatabase(
	opts: ChooseOptions,
	server: DiscoveredServer,
	configured: ReadonlyMap<string, string>
): Promise<ParsedConnection> {
	const password =
		server.password !== undefined || server.passwordless
			? server.password
			: await opts.prompter.password(
					`Mot de passe de ${server.user}@${server.host}:${server.port} : `
				);
	const maintenanceUrl = serverConnection(
		server,
		server.maintenanceDatabase,
		password
	).url;
	if (!server.running) await ensureRunning(opts, server, maintenanceUrl);
	let names: readonly string[] = [];
	if (opts.listDatabases !== undefined) {
		try {
			names = await opts.listDatabases(maintenanceUrl);
		} catch (err) {
			opts.stdout(
				`✗ Bases de ${server.name} illisibles : ${describeFailure(err)}`
			);
		}
	}
	if (names.length === 0) {
		const fallback = server.defaultDatabase ?? server.maintenanceDatabase;
		const typed = (await opts.prompter.line(`Base [${fallback}] : `)).trim();
		return serverConnection(server, typed !== "" ? typed : fallback, password);
	}
	const choices = names.map((name) => {
		const connection = serverConnection(server, name, password);
		const already = configured.get(connectionIdentity(connection));
		return {
			value: connection,
			label: name,
			...(already !== undefined
				? { disabled: `déjà configurée : ${already}` }
				: {})
		};
	});
	const free = choices.filter((c) => c.disabled === undefined);
	const [first] = free;
	if (first === undefined) {
		throw new AddConnectionError(
			"cancelled",
			`Toutes les bases de ${server.name} sont déjà configurées.`
		);
	}
	if (choices.length === 1) {
		opts.stdout(`Base : ${first.label}`);
		return first.value;
	}
	return opts.prompter.select({ message: `Base de ${server.name}`, choices });
}

function describeSource(
	source: DiscoveredSource,
	root: string | undefined
): string {
	switch (source.kind) {
		case "env-file":
			return `${source.key} · ${shortPath(source.file, root)}`;
		case "orm-config":
			return shortPath(source.file, root);
		case "compose":
			return `${source.key} · service ${source.service} · ${shortPath(source.file, root)}`;
	}
}

/** `user@hôte:port`, sans la base (première colonne) ni le secret. */
function describeServerOf(c: ParsedConnection): string {
	return describeConnection({ ...c, database: undefined });
}
