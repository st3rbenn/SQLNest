/**
 * `sqlnest add-connection --name <n>` — ajoute (ou remplace) une DSN
 * Postgres locale dans `~/.sqlnest/local-connections.toml`.
 *
 * ─── Deux formes ──────────────────────────────────────────────────────
 * **Interactive (recommandée)** — password saisi sans écho, jamais dans
 * l'historique shell / `ps aux` :
 *   sqlnest add-connection --name apollon
 *   Host: localhost / Port: 5432 / Database: … / User: … / Password: ****
 *
 * **DSN inline (`--url`) — scriptable** :
 *   sqlnest add-connection --name apollon --url postgres://user:pass@h:5432/db
 * ⚠ Le password sera visible dans `ps aux` et pourra atterrir dans
 *   l'historique shell (~/.zsh_history) : à utiliser quand la DSN vient
 *   déjà d'un secret manager ou d'un shell script, PAS quand elle est
 *   tapée à la main.
 *
 * ─── Écrasement ───────────────────────────────────────────────────────
 * Si `--name` existe déjà : prompt "Écraser ? [y/N]" — sauf `--force` qui
 * skip la question. Pas de merge : la nouvelle entrée remplace intégrale.
 *
 * ─── URL encoding (interactif) ────────────────────────────────────────
 * En mode interactif, `user` et `password` peuvent contenir `@`, `:`, `/`
 * — ces caractères sont URI-encoded pour que la DSN reste parsable. En
 * mode `--url`, la DSN est prise telle quelle (l'user gère lui-même).
 */

import { defineCommand, parseCommandArgs } from "../app/command";
import {
	type ParsedConnection,
	parseConnectionString,
	suggestConnectionName
} from "../services/connection-strings";
import { type ConnectionProbe, describeServer } from "../services/engine";
import {
	addLocalConnection,
	loadLocalConnections
} from "../services/local-connections";
import type { Prompter } from "../ui/prompts";

export class AddConnectionError extends Error {
	readonly kind: "cancelled" | "invalid-input" | "unreachable";
	constructor(kind: AddConnectionError["kind"], message: string) {
		super(message);
		this.name = "AddConnectionError";
		this.kind = kind;
	}
}

export interface AddConnectionOptions {
	/** Absent (avec `url`) : nom proposé d'après la base (ADR-038 S2). */
	readonly name?: string;
	readonly force?: boolean;
	/** Chaîne de connexion complète — skip tous les prompts. URL, JDBC,
	 *  ADO.NET ou libpq (ADR-038 S3), normalisée en URL. */
	readonly url?: string;
	/** Test de la connexion avant d'enregistrer ; absent = pas de test. */
	readonly test?: (url: string) => Promise<ConnectionProbe>;
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

const PORT_RE = /^[0-9]{1,5}$/;

export async function addConnection(
	opts: AddConnectionOptions
): Promise<AddConnectionResult> {
	const taken = loadLocalConnections()?.connections.map((c) => c.name) ?? [];
	// Nom connu d'avance : la question d'écrasement vient avant les prompts.
	if (opts.name !== undefined) await confirmOverwrite(opts, opts.name, taken);

	// ─── Mode --url : chaîne prise telle quelle, skip prompts ─────────
	let url: string;
	if (opts.url !== undefined) {
		const parsed = parseConnectionString(opts.url);
		if (parsed === undefined) {
			throw new AddConnectionError(
				"invalid-input",
				"Chaîne de connexion non reconnue (attendu : URL postgres:// / mongodb:// / mssql://, JDBC, ADO.NET ou libpq)"
			);
		}
		url = parsed.url;
	} else {
		url = await promptConnectionUrl(opts);
	}
	const parsed = parseConnectionString(url) as ParsedConnection;
	const name = opts.name ?? suggestConnectionName(parsed, taken);

	if (opts.test !== undefined) {
		try {
			const probe = await opts.test(url);
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
	addLocalConnection({ name, url });
	opts.stdout(
		`✓ Connection « ${name} » ${alreadyExists ? "remplacée" : "ajoutée"} dans ~/.sqlnest/local-connections.toml (perms 0600)`
	);
	return { name, overwritten: alreadyExists };
}

/**
 * Message d'un échec de connexion, cause du pilote comprise. Une
 * `AggregateError` (une tentative IPv6 et une IPv4) a un message vide : ses
 * erreurs internes portent la cause.
 */
function describeFailure(err: unknown): string {
	const message = (err as Error)?.message ?? String(err);
	const cause = (err as { cause?: unknown })?.cause;
	if (!(cause instanceof Error)) return message;
	const inner = (cause as { errors?: unknown }).errors;
	const causeMessage =
		cause.message !== ""
			? cause.message
			: Array.isArray(inner)
				? [
						...new Set(inner.map((e) => (e as Error)?.message ?? String(e)))
					].join(", ")
				: "";
	return causeMessage !== "" && !message.includes(causeMessage)
		? `${message} — ${causeMessage}`
		: message;
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

/** Saisie guidée : moteur, hôte, port, base, utilisateur, mot de passe. */
async function promptConnectionUrl(
	opts: AddConnectionOptions
): Promise<string> {
	// Sélection de l'engine en tête — le port default + le scheme DSN
	// dépendent de ce choix. Sur non-TTY, le prompter.select throw : le
	// caller peut fallback sur `--url` (mode scriptable).
	const engine = await opts.prompter.select<"postgres" | "mongodb" | "mssql">({
		message: "Engine",
		choices: [
			{ value: "postgres", label: "PostgreSQL", description: "port 5432 par défaut" },
			{ value: "mongodb", label: "MongoDB", description: "port 27017 par défaut" },
			{ value: "mssql", label: "SQL Server", description: "port 1433 par défaut" }
		]
	});
	const defaultPort =
		engine === "postgres" ? "5432" : engine === "mongodb" ? "27017" : "1433";

	const host = (await opts.prompter.line("Host: ")).trim();
	if (!host) throw new AddConnectionError("invalid-input", "Host vide");

	const portStr = ((await opts.prompter.line(`Port [${defaultPort}]: `)).trim() || defaultPort);
	if (!PORT_RE.test(portStr)) {
		throw new AddConnectionError(
			"invalid-input",
			"Port invalide (chiffres uniquement)"
		);
	}
	const port = Number(portStr);
	if (port < 1 || port > 65535) {
		throw new AddConnectionError("invalid-input", "Port hors bornes (1–65535)");
	}

	const database = (await opts.prompter.line("Database: ")).trim();
	if (!database) throw new AddConnectionError("invalid-input", "Database vide");

	// Mongo autorise les connexions anonymes (mongodb://host:port/db) — user
	// et password vides sont valides. Postgres et MSSQL non — user obligatoire.
	const user = (await opts.prompter.line(
		engine === "mongodb" ? "User (vide pour anonyme): " : "User: "
	)).trim();
	if (engine !== "mongodb" && !user) {
		throw new AddConnectionError("invalid-input", "User vide");
	}

	let password = "";
	if (user) {
		password = await opts.prompter.password("Password: ");
		if (!password) throw new AddConnectionError("invalid-input", "Password vide");
	}

	// Mongo : les root users créés via MONGO_INITDB_ROOT_USERNAME vivent
	// dans la DB `admin`, pas dans la DB cible. Le driver s'authentifie
	// par défaut contre la DB du path — un prompt optionnel permet à
	// l'user d'indiquer `admin` (ou autre) sans devoir éditer la DSN.
	// Ignoré pour Postgres (l'auth est toujours contre la DB du path).
	let authSource = "";
	if (engine === "mongodb" && user) {
		authSource = (await opts.prompter.line(
			`Auth source [${database}]: `
		)).trim();
	}

	// MSSQL : les instances dev/legacy présentent souvent un cert
	// self-signed (docker 2022, chaînes Windows 2014) — prompt explicite,
	// jamais de trust silencieux (même politique que le sslmode PG).
	let trustServerCertificate = false;
	if (engine === "mssql") {
		const trust = (await opts.prompter.line(
			"Trust server certificate (self-signed) ? [y/N]: "
		))
			.trim()
			.toLowerCase();
		trustServerCertificate = trust === "y" || trust === "yes";
	}

	const scheme =
		engine === "postgres" ? "postgres" : engine === "mongodb" ? "mongodb" : "mssql";
	const auth = user
		? `${encodeURIComponent(user)}:${encodeURIComponent(password)}@`
		: "";
	const query =
		authSource && authSource !== database
			? `?authSource=${encodeURIComponent(authSource)}`
			: trustServerCertificate
				? "?trustServerCertificate=true"
				: "";
	return `${scheme}://${auth}${host}:${port}/${encodeURIComponent(database)}${query}`;
}

export const addConnectionCommand = defineCommand({
	name: "add-connection",
	help: [
		[
			"sqlnest add-connection --name <n>",
			"Ajoute une DSN locale (menu engine + prompts interactifs)"
		],
		[
			"sqlnest add-connection --name <n> --url <dsn>",
			"DSN inline (⚠ visible dans ps aux / historique shell)"
		],
		[
			"sqlnest add-connection --url <chaîne>",
			"URL, JDBC, ADO.NET ou libpq ; nom proposé d'après la base"
		],
		[
			"sqlnest add-connection --name <n> --force",
			"Écrase sans demander confirmation"
		],
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
		const name = values.name;
		if (!name && !values.url) {
			ctx.stderr(
				"sqlnest add-connection: `--name <label>` est requis. Ex: sqlnest add-connection --name apollon"
			);
			return 2;
		}
		const prompter = ctx.services.prompter();
		try {
			await ctx.services.addConnection({
				...(name ? { name } : {}),
				...(values.force ? { force: true } : {}),
				...(values.url ? { url: values.url } : {}),
				...(values["no-test"] ? {} : { test: ctx.services.probeConnection }),
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
			ctx.stderr(`✗ ${(err as Error).message ?? String(err)}`);
			return 1;
		} finally {
			// Le prompter par défaut détient une readline.Interface — la close
			// permet au process de se terminer naturellement (sans SIGKILL).
			prompter.close?.();
		}
	}
});
