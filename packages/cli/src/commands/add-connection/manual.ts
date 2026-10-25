import type { Prompter } from "../../ui/prompts";
import { AddConnectionError } from "./errors";

const PORT_RE = /^[0-9]{1,5}$/;

/** Saisie guidée : moteur, hôte, port, base, utilisateur, mot de passe. */
export async function promptConnectionUrl(prompter: Prompter): Promise<string> {
	// Sélection de l'engine en tête — le port default + le scheme DSN
	// dépendent de ce choix. Sur non-TTY, le prompter.select throw : le
	// caller peut fallback sur `--url` (mode scriptable).
	const engine = await prompter.select<"postgres" | "mongodb" | "mssql">({
		message: "Engine",
		choices: [
			{
				value: "postgres",
				label: "PostgreSQL",
				description: "port 5432 par défaut"
			},
			{
				value: "mongodb",
				label: "MongoDB",
				description: "port 27017 par défaut"
			},
			{
				value: "mssql",
				label: "SQL Server",
				description: "port 1433 par défaut"
			}
		]
	});
	const defaultPort =
		engine === "postgres" ? "5432" : engine === "mongodb" ? "27017" : "1433";

	const host = (await prompter.line("Host: ")).trim();
	if (!host) throw new AddConnectionError("invalid-input", "Host vide");

	const portStr =
		(await prompter.line(`Port [${defaultPort}]: `)).trim() || defaultPort;
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

	const database = (await prompter.line("Database: ")).trim();
	if (!database) throw new AddConnectionError("invalid-input", "Database vide");

	// Mongo autorise les connexions anonymes (mongodb://host:port/db) — user
	// et password vides sont valides. Postgres et MSSQL non — user obligatoire.
	const user = (
		await prompter.line(
			engine === "mongodb" ? "User (vide pour anonyme): " : "User: "
		)
	).trim();
	if (engine !== "mongodb" && !user) {
		throw new AddConnectionError("invalid-input", "User vide");
	}

	let password = "";
	if (user) {
		password = await prompter.password("Password: ");
		if (!password)
			throw new AddConnectionError("invalid-input", "Password vide");
	}

	// Mongo : les root users créés via MONGO_INITDB_ROOT_USERNAME vivent
	// dans la DB `admin`, pas dans la DB cible. Le driver s'authentifie
	// par défaut contre la DB du path — un prompt optionnel permet à
	// l'user d'indiquer `admin` (ou autre) sans devoir éditer la DSN.
	// Ignoré pour Postgres (l'auth est toujours contre la DB du path).
	let authSource = "";
	if (engine === "mongodb" && user) {
		authSource = (await prompter.line(`Auth source [${database}]: `)).trim();
	}

	// MSSQL : les instances dev/legacy présentent souvent un cert
	// self-signed (docker 2022, chaînes Windows 2014) — prompt explicite,
	// jamais de trust silencieux (même politique que le sslmode PG).
	let trustServerCertificate = false;
	if (engine === "mssql") {
		const trust = (
			await prompter.line("Trust server certificate (self-signed) ? [y/N]: ")
		)
			.trim()
			.toLowerCase();
		trustServerCertificate = trust === "y" || trust === "yes";
	}

	const scheme =
		engine === "postgres"
			? "postgres"
			: engine === "mongodb"
				? "mongodb"
				: "mssql";
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
