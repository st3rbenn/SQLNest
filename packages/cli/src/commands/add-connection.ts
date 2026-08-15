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

import { addLocalConnection, loadLocalConnections } from "../local-connections";
import type { Prompter } from "../prompts";

export class AddConnectionError extends Error {
	readonly kind: "cancelled" | "invalid-input";
	constructor(kind: AddConnectionError["kind"], message: string) {
		super(message);
		this.name = "AddConnectionError";
		this.kind = kind;
	}
}

export interface AddConnectionOptions {
	readonly name: string;
	readonly force?: boolean;
	/** DSN complète — skip tous les prompts. Format `postgres://…` ou
	 *  `postgresql://…` (alias) ou `mongodb://…`. */
	readonly url?: string;
	readonly prompter: Prompter;
	readonly stdout: (line: string) => void;
}

export interface AddConnectionResult {
	readonly name: string;
	readonly overwritten: boolean;
}

const PORT_RE = /^[0-9]{1,5}$/;
const DSN_RE = /^(postgres|postgresql|mongodb(\+srv)?):\/\/.+/;

export async function addConnection(
	opts: AddConnectionOptions
): Promise<AddConnectionResult> {
	const existing = loadLocalConnections();
	const alreadyExists =
		existing?.connections.some((c) => c.name === opts.name) ?? false;

	if (alreadyExists && !opts.force) {
		const ok = await opts.prompter.confirm(
			`Une entrée « ${opts.name} » existe déjà. Écraser ? [y/N] `
		);
		if (!ok) {
			throw new AddConnectionError("cancelled", "Annulé par l'utilisateur");
		}
	}

	// ─── Mode --url : DSN prise telle quelle, skip prompts ────────────
	if (opts.url !== undefined) {
		const url = opts.url.trim();
		if (!DSN_RE.test(url)) {
			throw new AddConnectionError(
				"invalid-input",
				"DSN invalide (attendu: postgres://… ou postgresql://… ou mongodb://…)"
			);
		}
		addLocalConnection({ name: opts.name, url });
		opts.stdout(
			`✓ Connection « ${opts.name} » ${alreadyExists ? "remplacée" : "ajoutée"} dans ~/.sqlnest/local-connections.toml (perms 0600)`
		);
		return { name: opts.name, overwritten: alreadyExists };
	}

	// Sélection de l'engine en tête — le port default + le scheme DSN
	// dépendent de ce choix. Sur non-TTY, le prompter.select throw : le
	// caller peut fallback sur `--url` (mode scriptable).
	const engine = await opts.prompter.select<"postgres" | "mongodb">({
		message: "Engine",
		choices: [
			{ value: "postgres", label: "PostgreSQL", description: "port 5432 par défaut" },
			{ value: "mongodb", label: "MongoDB", description: "port 27017 par défaut" }
		]
	});
	const defaultPort = engine === "postgres" ? "5432" : "27017";

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
	// et password vides sont valides. Postgres non — user obligatoire.
	const user = (await opts.prompter.line(
		engine === "mongodb" ? "User (vide pour anonyme): " : "User: "
	)).trim();
	if (engine === "postgres" && !user) {
		throw new AddConnectionError("invalid-input", "User vide");
	}

	let password = "";
	if (user) {
		password = await opts.prompter.password("Password: ");
		if (!password) throw new AddConnectionError("invalid-input", "Password vide");
	}

	const scheme = engine === "postgres" ? "postgres" : "mongodb";
	const auth = user
		? `${encodeURIComponent(user)}:${encodeURIComponent(password)}@`
		: "";
	const url = `${scheme}://${auth}${host}:${port}/${encodeURIComponent(database)}`;

	addLocalConnection({ name: opts.name, url });

	opts.stdout(
		`✓ Connection « ${opts.name} » ${alreadyExists ? "remplacée" : "ajoutée"} dans ~/.sqlnest/local-connections.toml (perms 0600)`
	);

	return { name: opts.name, overwritten: alreadyExists };
}
