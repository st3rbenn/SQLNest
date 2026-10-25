/**
 * `sqlnest add-connection` — ajoute (ou remplace) une connexion locale dans
 * `~/.sqlnest/local-connections.toml` (ADR-038 S2).
 *
 * ─── Trois formes ─────────────────────────────────────────────────────
 * **Sans argument** — les bases trouvées sur la machine (projet courant,
 * conteneurs Docker : `discovered.ts`), une chaîne collée sans écho, ou la
 * saisie guidée (`manual.ts`). Une base lue dans un `.env` est enregistrée
 * en référence à ce `.env` (ADR-038 S4).
 *
 * **`--url <chaîne>` — scriptable** : URL, JDBC, ADO.NET ou libpq.
 * ⚠ Le password sera visible dans `ps aux` et pourra atterrir dans
 *   l'historique shell (~/.zsh_history) : à utiliser quand la DSN vient
 *   déjà d'un secret manager ou d'un shell script, PAS quand elle est
 *   tapée à la main.
 *
 * La connexion est testée avant d'être enregistrée ; le nom est proposé
 * d'après la base, `--name` l'impose.
 *
 * ─── Écrasement ───────────────────────────────────────────────────────
 * Si le nom existe déjà : prompt "Écraser ? [y/N]" — sauf `--force` qui
 * skip la question. Pas de merge : la nouvelle entrée remplace intégrale.
 */

import { defineCommand, parseCommandArgs } from "../../app/command";
import {
	type ParsedConnection,
	parseConnectionString,
	suggestConnectionName
} from "../../services/connection-strings";
import { configuredIdentities, type Discovery } from "../../services/discovery";
import { type ConnectionProbe, describeServer } from "../../services/engine";
import {
	addLocalConnection,
	loadLocalConnections
} from "../../services/local-connections";
import { tildify } from "../../ui/paths";
import type { Prompter } from "../../ui/prompts";
import { withSpinner } from "../../ui/spinner";
import { type ConnectionTarget, chooseDiscovered } from "./discovered";
import {
	AddConnectionError,
	describeFailure,
	unrecognizedConnection
} from "./errors";
import { promptConnectionUrl } from "./manual";

export { AddConnectionError } from "./errors";

export interface AddConnectionOptions {
	/** Absent : nom proposé d'après la base (ADR-038 S2). */
	readonly name?: string;
	readonly force?: boolean;
	/** Chaîne de connexion complète — skip tous les prompts. URL, JDBC,
	 *  ADO.NET ou libpq (ADR-038 S3), normalisée en URL. */
	readonly url?: string;
	/** Test de la connexion avant d'enregistrer ; absent = pas de test. */
	readonly test?: (url: string) => Promise<ConnectionProbe>;
	/** Bases trouvées sur la machine, proposées sans `url` (ADR-038 S1) ;
	 *  absent : saisie guidée. */
	readonly discover?: () => Promise<Discovery>;
	/** Bases d'un serveur découvert, lues en direct. */
	readonly listDatabases?: (url: string) => Promise<readonly string[]>;
	/** `false` (stdin redirigé, script) : aucune question ; une base
	 *  injoignable fait échouer la commande. Défaut `true`. */
	readonly interactive?: boolean;
	readonly prompter: Prompter;
	readonly stdout: (line: string) => void;
}

export interface AddConnectionResult {
	readonly name: string;
	readonly overwritten: boolean;
}

export async function addConnection(
	opts: AddConnectionOptions
): Promise<AddConnectionResult> {
	const entries = loadLocalConnections()?.connections ?? [];
	const taken = entries.map((c) => c.name);
	// Nom connu d'avance : la question d'écrasement vient avant les prompts.
	if (opts.name !== undefined) await confirmOverwrite(opts, opts.name, taken);

	let target: ConnectionTarget;
	if (opts.url !== undefined) {
		// ─── Mode --url : chaîne prise telle quelle, skip prompts ─────
		const parsed = parseConnectionString(opts.url);
		if (parsed === undefined) throw unrecognizedConnection();
		target = { url: parsed.url };
	} else if (opts.interactive === false) {
		throw new AddConnectionError(
			"invalid-input",
			"Sans terminal, passe la chaîne de connexion : sqlnest add-connection --url <chaîne>"
		);
	} else if (opts.discover !== undefined) {
		target = await chooseDiscovered(
			{
				prompter: opts.prompter,
				stdout: opts.stdout,
				...(opts.listDatabases !== undefined
					? { listDatabases: opts.listDatabases }
					: {}),
				manual: () => promptConnectionUrl(opts.prompter)
			},
			await opts.discover(),
			configuredIdentities(entries)
		);
	} else {
		target = { url: await promptConnectionUrl(opts.prompter) };
	}
	const parsed = parseConnectionString(target.url) as ParsedConnection;
	let name = opts.name;
	if (name === undefined) {
		const suggested = suggestConnectionName(parsed, taken);
		name =
			opts.url !== undefined
				? suggested
				: await askName(opts, suggested, taken);
	}

	if (opts.test !== undefined) {
		try {
			const probe = await opts.test(target.url);
			opts.stdout(
				`✓ ${describeServer(parsed.engine, probe.serverVersion)} — ${probe.collectionCount} ${
					probe.collectionCount === 1 ? "table" : "tables"
				}`
			);
		} catch (err) {
			const reason = describeFailure(err);
			if (opts.interactive === false) {
				throw new AddConnectionError(
					"unreachable",
					`Connexion impossible : ${reason} — relance avec --no-test pour l'enregistrer sans la tester.`
				);
			}
			opts.stdout(`✗ Connexion impossible : ${reason}`);
			const keep = await opts.prompter.confirm(
				"Enregistrer quand même ? [y/N] "
			);
			if (!keep) {
				throw new AddConnectionError(
					"cancelled",
					"Annulé — rien n'a été enregistré"
				);
			}
		}
	}

	const alreadyExists = taken.includes(name);
	addLocalConnection(
		target.urlFrom !== undefined
			? { name, urlFrom: target.urlFrom }
			: { name, url: target.url }
	);
	opts.stdout(
		`✓ Connection « ${name} » ${alreadyExists ? "remplacée" : "ajoutée"} dans ~/.sqlnest/local-connections.toml (perms 0600)`
	);
	if (target.urlFrom !== undefined) {
		opts.stdout(
			`  URL relue dans ${tildify(target.urlFrom.file)} (${target.urlFrom.key}) à chaque connexion`
		);
	}
	return { name, overwritten: alreadyExists };
}

/** Nom proposé d'après la base ; Entrée l'accepte. */
async function askName(
	opts: AddConnectionOptions,
	suggested: string,
	taken: readonly string[]
): Promise<string> {
	const typed = (await opts.prompter.line(`Nom [${suggested}] : `)).trim();
	const name = typed !== "" ? typed : suggested;
	await confirmOverwrite(opts, name, taken);
	return name;
}

async function confirmOverwrite(
	opts: AddConnectionOptions,
	name: string,
	taken: readonly string[]
): Promise<void> {
	if (!taken.includes(name) || opts.force) return;
	const ok = await opts.prompter.confirm(
		`Une entrée « ${name} » existe déjà. Écraser ? [y/N] `
	);
	if (!ok) {
		throw new AddConnectionError("cancelled", "Annulé par l'utilisateur");
	}
}

export const addConnectionCommand = defineCommand({
	name: "add-connection",
	help: [
		[
			"sqlnest add-connection",
			"Bases trouvées (projet courant, Docker), chaîne collée ou saisie"
		],
		[
			"sqlnest add-connection --url <chaîne>",
			"URL, JDBC, ADO.NET ou libpq (⚠ visible dans ps aux / historique shell)"
		],
		[
			"sqlnest add-connection … --name <n>",
			"Nom de la connexion (proposé d'après la base sinon)"
		],
		["sqlnest add-connection … --force", "Écrase sans demander confirmation"],
		[
			"sqlnest add-connection … --no-test",
			"Enregistre sans tester la connexion"
		]
	],
	async run(args, ctx) {
		const values = parseCommandArgs(ctx, "add-connection", args, {
			name: { type: "string" },
			force: { type: "boolean" },
			url: { type: "string" },
			"no-test": { type: "boolean" }
		});
		if (values === undefined) return 2;
		const prompter = ctx.services.prompter();
		try {
			await ctx.services.addConnection({
				...(values.name ? { name: values.name } : {}),
				...(values.force ? { force: true } : {}),
				...(values.url ? { url: values.url } : {}),
				...(values["no-test"] ? {} : { test: ctx.services.probeConnection }),
				discover: () =>
					withSpinner("Recherche des bases (projet, Docker)…", () =>
						ctx.services.discoverDatabases()
					),
				listDatabases: (url) =>
					withSpinner("Lecture des bases du serveur…", () =>
						ctx.services.listServerDatabases(url)
					),
				interactive: process.stdin.isTTY === true,
				prompter,
				stdout: ctx.stdout
			});
			return 0;
		} catch (err) {
			if (err instanceof AddConnectionError) {
				ctx.stderr(`✗ ${err.message}`);
				return err.kind === "invalid-input" ? 2 : 1;
			}
			// Ctrl-C dans un menu (inquirer).
			if ((err as Error).name === "ExitPromptError") {
				ctx.stderr("✗ Annulé — rien n'a été enregistré");
				return 130;
			}
			ctx.stderr(`✗ ${(err as Error).message ?? String(err)}`);
			return 1;
		} finally {
			// Le prompter par défaut détient une readline.Interface — la close
			// permet au process de se terminer naturellement (sans SIGKILL).
			prompter.close?.();
		}
	}
});
