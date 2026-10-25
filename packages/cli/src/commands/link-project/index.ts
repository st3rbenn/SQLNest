/**
 * `sqlnest link-project` — relie le projet d'un ORM à une connexion locale :
 * l'éditeur de schéma y écrira ses migrations (ADR-038 S5, ADR-037 D1).
 *
 * Sans argument, dans un projet : ORM et base détectés, connexion retrouvée
 * (même base) ou créée, table d'historique vérifiée. `<connexion> <dossier>`
 * les désigne à la main. `--no-apply` : migration et modèle écrits, base non
 * touchée (base déployée par la CI). Le chemin reste dans
 * `~/.sqlnest/local-connections.toml`, jamais envoyé.
 */

import { statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { defineCommand, parseCommandLine } from "../../app/command";
import { detectOrms, type OrmDetection } from "../../orm/detect";
import { ORM_LABELS } from "../../orm/types";
import {
	connectionIdentity,
	describeConnection,
	parseConnectionString
} from "../../services/connection-strings";
import {
	configuredIdentities,
	type DiscoveredDatabase,
	type Discovery,
	isInside
} from "../../services/discovery";
import type { ConnectionProbe } from "../../services/engine";
import {
	entryUrl,
	type LocalConnectionEntry,
	type LocalConnectionProject,
	loadLocalConnections
} from "../../services/local-connections";
import { tildify } from "../../ui/paths";
import { confirmDefaultYes, type Prompter } from "../../ui/prompts";
import { AddConnectionError, discoveryTools } from "../add-connection";
import { LinkProjectError, linkConnection } from "./link";

export { LinkProjectError } from "./link";

export interface LinkProjectOptions {
	/** Avec `dir` : liaison désignée à la main. */
	readonly connection?: string;
	readonly dir?: string;
	readonly apply: boolean;
	readonly cwd: string;
	readonly discover: (cwd: string) => Promise<Discovery>;
	readonly probe: (url: string) => Promise<ConnectionProbe>;
	/** Crée la connexion d'une base découverte ; rend son nom. */
	readonly createConnection: (database: DiscoveredDatabase) => Promise<string>;
	readonly interactive: boolean;
	readonly prompter: Prompter;
	readonly stdout: (line: string) => void;
}

export interface LinkProjectResult {
	readonly name: string;
	readonly project: LocalConnectionProject;
}

/** Un projet ORM trouvé, et la base qu'il lit quand elle a pu l'être. */
interface Candidate {
	readonly detection: OrmDetection;
	readonly database?: DiscoveredDatabase;
	readonly reason?: string;
}

export async function linkProject(
	opts: LinkProjectOptions
): Promise<LinkProjectResult> {
	const entries = loadLocalConnections()?.connections ?? [];
	if (opts.connection !== undefined || opts.dir !== undefined) {
		return linkDesignated(opts, entries);
	}
	const discovery = await opts.discover(opts.cwd);
	const candidates: Candidate[] = [
		...discovery.databases.flatMap((database) =>
			database.orm !== undefined ? [{ detection: database.orm, database }] : []
		),
		...discovery.unresolved.map((u) => ({ detection: u.orm, reason: u.reason }))
	];
	if (candidates.length === 0) {
		throw new LinkProjectError(
			"not-found",
			"Aucun projet Prisma, Doctrine, Sequelize ou SeaORM ici."
		);
	}
	const candidate = await pickCandidate(opts, candidates, discovery.root);
	const name = await connectionFor(opts, entries, candidate);
	const project = await linkConnection({
		name,
		detection: candidate.detection,
		apply: opts.apply,
		probe: opts.probe,
		interactive: opts.interactive,
		prompter: opts.prompter,
		stdout: opts.stdout
	});
	return { name, project };
}

/** Le projet du dossier courant, sinon celui que l'utilisateur choisit. */
async function pickCandidate(
	opts: LinkProjectOptions,
	candidates: readonly Candidate[],
	root: string | undefined
): Promise<Candidate> {
	const [only] = candidates;
	if (only !== undefined && candidates.length === 1) return only;
	const containing = candidates
		.filter((c) => isInside(opts.cwd, c.detection.dir))
		.sort((a, b) => b.detection.dir.length - a.detection.dir.length)[0];
	if (containing !== undefined) return containing;
	const label = (c: Candidate): string =>
		`${ORM_LABELS[c.detection.orm]} · ${
			root !== undefined
				? relative(root, c.detection.dir) || "."
				: tildify(c.detection.dir)
		}`;
	if (!opts.interactive) {
		throw new LinkProjectError(
			"invalid-input",
			`Plusieurs projets (${candidates.map(label).join(", ")}) : lance la commande dans l'un d'eux, ou sqlnest link-project <connexion> <dossier>.`
		);
	}
	return opts.prompter.select({
		message: "Projet à relier",
		choices: candidates.map((c) => ({
			value: c,
			label: label(c),
			description:
				c.database !== undefined
					? describeConnection(c.database.connection)
					: (c.reason ?? "")
		}))
	});
}

/** La connexion qui vise la base du projet, sinon créée avec l'accord de l'utilisateur. */
async function connectionFor(
	opts: LinkProjectOptions,
	entries: readonly LocalConnectionEntry[],
	candidate: Candidate
): Promise<string> {
	const { database, detection } = candidate;
	if (database === undefined) {
		throw new LinkProjectError(
			"not-found",
			`${ORM_LABELS[detection.orm]} : ${candidate.reason ?? "base introuvable"} — relie à la main : sqlnest link-project <connexion> ${tildify(detection.dir)}`
		);
	}
	const existing = configuredIdentities(entries).get(
		connectionIdentity(database.connection)
	);
	if (existing !== undefined) {
		opts.stdout(
			`Connexion : ${existing} (${describeConnection(database.connection)})`
		);
		return existing;
	}
	const described = describeConnection(database.connection);
	if (!opts.interactive) {
		throw new LinkProjectError(
			"not-found",
			`Aucune connexion ne vise ${described} — crée-la : sqlnest add-connection`
		);
	}
	if (
		!(await confirmDefaultYes(
			opts.prompter,
			`Aucune connexion ne vise ${described}. La créer ? [Y/n] `
		))
	) {
		throw new LinkProjectError("cancelled", "Annulé — rien n'a été relié");
	}
	return opts.createConnection(database);
}

/** `link-project <connexion> <dossier>`. */
async function linkDesignated(
	opts: LinkProjectOptions,
	entries: readonly LocalConnectionEntry[]
): Promise<LinkProjectResult> {
	if (opts.connection === undefined || opts.dir === undefined) {
		throw new LinkProjectError(
			"invalid-input",
			"Usage : sqlnest link-project <connexion> <dossier>"
		);
	}
	const name = opts.connection;
	const entry = entries.find((c) => c.name === name);
	if (entry === undefined) {
		const known = entries.map((c) => c.name).join(", ");
		throw new LinkProjectError(
			"not-found",
			`Aucune connexion « ${name} »${known !== "" ? ` (connues : ${known})` : ""}.`
		);
	}
	const dir = resolve(opts.cwd, opts.dir);
	if (!isDirectory(dir)) {
		throw new LinkProjectError("not-found", `Dossier introuvable : ${dir}`);
	}
	const detections = detectOrms(dir);
	const [first] = detections;
	if (first === undefined) {
		throw new LinkProjectError(
			"not-found",
			`Aucun projet Prisma, Doctrine, Sequelize ou SeaORM dans ${tildify(dir)}.`
		);
	}
	let detection = first;
	if (detections.length > 1) {
		if (!opts.interactive) {
			throw new LinkProjectError(
				"invalid-input",
				`Plusieurs ORM dans ${tildify(dir)} : ${detections.map((d) => ORM_LABELS[d.orm]).join(", ")}.`
			);
		}
		detection = await opts.prompter.select({
			message: "ORM à relier",
			choices: detections.map((d) => ({ value: d, label: ORM_LABELS[d.orm] }))
		});
	}
	await confirmSameDatabase(opts, entry, detection);
	const project = await linkConnection({
		name,
		detection,
		apply: opts.apply,
		probe: opts.probe,
		interactive: opts.interactive,
		prompter: opts.prompter,
		stdout: opts.stdout
	});
	return { name, project };
}

/** La base que lit le projet doit être celle de la connexion, sauf accord explicite. */
async function confirmSameDatabase(
	opts: LinkProjectOptions,
	entry: LocalConnectionEntry,
	detection: OrmDetection
): Promise<void> {
	const discovery = await opts.discover(detection.dir);
	const projectDb = discovery.databases.find(
		(d) => d.orm?.dir === detection.dir && d.orm.orm === detection.orm
	)?.connection;
	let connectionDb: ReturnType<typeof parseConnectionString>;
	try {
		connectionDb = parseConnectionString(entryUrl(entry));
	} catch {
		connectionDb = undefined;
	}
	if (
		projectDb === undefined ||
		connectionDb === undefined ||
		connectionIdentity(projectDb) === connectionIdentity(connectionDb)
	) {
		return;
	}
	const message = `Le projet lit ${describeConnection(projectDb)} ; « ${entry.name} » vise ${describeConnection(connectionDb)}`;
	if (!opts.interactive) throw new LinkProjectError("mismatch", message);
	opts.stdout(`⚠ ${message}`);
	if (!(await opts.prompter.confirm("Relier quand même ? [y/N] "))) {
		throw new LinkProjectError("cancelled", "Annulé — rien n'a été relié");
	}
}

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

export const linkProjectCommand = defineCommand({
	name: "link-project",
	help: [
		[
			"sqlnest link-project",
			"Relie le projet du dossier courant (ORM et base détectés)"
		],
		[
			"sqlnest link-project <connexion> <dossier>",
			"Relie ce dossier à cette connexion"
		],
		[
			"sqlnest link-project … --no-apply",
			"Migrations écrites sans toucher la base (déployée par la CI)"
		]
	],
	async run(args, ctx) {
		const parsed = parseCommandLine(
			ctx,
			"link-project",
			args,
			{ "no-apply": { type: "boolean" } },
			2
		);
		if (parsed === undefined) return 2;
		const [connection, dir] = parsed.positionals;
		if (connection !== undefined && dir === undefined) {
			ctx.stderr(
				"sqlnest link-project: usage — sqlnest link-project <connexion> <dossier>"
			);
			return 2;
		}
		const prompter = ctx.services.prompter();
		const interactive = process.stdin.isTTY === true;
		const tools = discoveryTools(ctx);
		try {
			await ctx.services.linkProject({
				...(connection !== undefined ? { connection } : {}),
				...(dir !== undefined ? { dir } : {}),
				apply: parsed.values["no-apply"] !== true,
				cwd: process.cwd(),
				discover: (cwd) => tools.discover(cwd),
				probe: ctx.services.probeConnection,
				createConnection: async (database) =>
					(
						await ctx.services.addConnection({
							database,
							offerLink: false,
							test: ctx.services.probeConnection,
							startServer: tools.startServer,
							interactive,
							prompter,
							stdout: ctx.stdout
						})
					).name,
				interactive,
				prompter,
				stdout: ctx.stdout
			});
			return 0;
		} catch (err) {
			if (
				err instanceof LinkProjectError ||
				err instanceof AddConnectionError
			) {
				ctx.stderr(`✗ ${err.message}`);
				return err.kind === "invalid-input" ? 2 : 1;
			}
			if ((err as Error).name === "ExitPromptError") {
				ctx.stderr("✗ Annulé — rien n'a été relié");
				return 130;
			}
			ctx.stderr(`✗ ${(err as Error).message ?? String(err)}`);
			return 1;
		} finally {
			prompter.close?.();
		}
	}
});
