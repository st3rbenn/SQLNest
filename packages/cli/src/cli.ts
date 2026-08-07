/**
 * Dispatcher `sqlnest` — parse argv, appelle la bonne command, format
 * la sortie utilisateur.
 *
 * ─── Design ───────────────────────────────────────────────────────────
 * `runCli(argv, io)` est le point d'entrée testable. Toutes les I/O
 * (stdout, stderr, env vars, commands) sont injectables. Le vrai `bin`
 * (à venir Bloc 5 fin ou Bloc 10) fait juste `runCli(process.argv.slice(2))`.
 *
 * ─── Subcommands ──────────────────────────────────────────────────────
 *   sqlnest connect                     (device flow interactif)
 *   sqlnest connect --token <sn> --name <n>  (mode CI Bearer)
 *   sqlnest connect --no-browser        (device flow sans open browser)
 *   sqlnest logout --all                (retire tous les tunnels locaux)
 *   sqlnest logout --tunnel <id>        (retire un tunnel local)
 *   sqlnest --help
 *   sqlnest --version
 *
 * ─── Env vars ─────────────────────────────────────────────────────────
 *   SQLNEST_API_URL       (défaut: http://localhost:4000)
 *   SQLNEST_FRONTEND_URL  (défaut: http://localhost:3000)
 *   SQLNEST_CONFIG_DIR    (défaut: ~/.sqlnest — utile pour tests)
 *
 * ─── Exit codes ───────────────────────────────────────────────────────
 *   0 : succès
 *   1 : erreur runtime (backend down, timeout, sig invalide…)
 *   2 : usage invalide (args manquants / inconnus)
 */

import { parseArgs } from "node:util";
import { ApiClientError } from "./api-client";
import {
	AddConnectionError,
	addConnection as defaultAddConnection
} from "./commands/add-connection";
import { ConnectError, connect as defaultConnect } from "./commands/connect";
import { connectWithToken as defaultConnectWithToken } from "./commands/connect-token";
import { logout as defaultLogout } from "./commands/logout";
import { ping as defaultPing } from "./commands/ping";
import {
	revokeConnection as defaultRevokeConnection,
	RevokeConnectionError
} from "./commands/revoke-connection";
import { serveTunnel as defaultServeTunnel } from "./commands/serve";
import {
	LocalConnectionNotFoundError,
	loadLocalConnections
} from "./local-connections";
import { defaultPrompter, type Prompter } from "./prompts";

const DEFAULT_API_URL = "http://localhost:4000";
const DEFAULT_FRONTEND_URL = "http://localhost:3000";
const CLI_VERSION = "0.0.1"; // TODO Bloc 10 : lire depuis package.json au build.

export interface CliIO {
	readonly stdout?: (line: string) => void;
	readonly stderr?: (line: string) => void;
	readonly env?: NodeJS.ProcessEnv;
	// Injection des commandes (test).
	readonly connectFn?: typeof defaultConnect;
	readonly connectWithTokenFn?: typeof defaultConnectWithToken;
	readonly logoutFn?: typeof defaultLogout;
	readonly pingFn?: typeof defaultPing;
	readonly serveTunnelFn?: typeof defaultServeTunnel;
	readonly addConnectionFn?: typeof defaultAddConnection;
	readonly revokeConnectionFn?: typeof defaultRevokeConnection;
	// Prompter injectable (test). Par défaut = `defaultPrompter()`.
	readonly prompter?: Prompter;
}

/** Retourne l'exit code (0 succès, 1 erreur, 2 usage). Ne process.exit
 * jamais — le caller décide (le vrai bin appellera `process.exit(code)`
 * en fin). */
export async function runCli(argv: string[], io: CliIO = {}): Promise<number> {
	const stdout =
		io.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
	const stderr =
		io.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
	const env = io.env ?? process.env;

	if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
		stdout(HELP_TEXT);
		return 0;
	}
	if (argv[0] === "--version" || argv[0] === "-v") {
		stdout(CLI_VERSION);
		return 0;
	}

	const [subcommand, ...rest] = argv;
	switch (subcommand) {
		case "connect":
			return runConnect(rest, { stdout, stderr, env, io });
		case "logout":
			return runLogout(rest, { stdout, stderr, io });
		case "ping":
			return runPing(rest, { stdout, stderr, env, io });
		case "add-connection":
			return runAddConnection(rest, { stdout, stderr, io });
		case "revoke-connection":
			return runRevokeConnection(rest, { stdout, stderr, io });
		default:
			stderr(`sqlnest: commande inconnue « ${subcommand} »`);
			stderr(HELP_TEXT);
			return 2;
	}
}

interface RunContext {
	readonly stdout: (line: string) => void;
	readonly stderr: (line: string) => void;
	readonly env?: NodeJS.ProcessEnv;
	readonly io: CliIO;
}

async function runConnect(args: string[], ctx: RunContext): Promise<number> {
	let parsed: {
		values: {
			token?: string;
			name?: string;
			connection?: string;
			"no-browser"?: boolean;
		};
	};
	try {
		parsed = parseArgs({
			args,
			options: {
				token: { type: "string" },
				name: { type: "string" },
				connection: { type: "string" },
				"no-browser": { type: "boolean" }
			},
			strict: true,
			allowPositionals: false
		});
	} catch (err) {
		ctx.stderr(`sqlnest connect: usage invalide — ${(err as Error).message}`);
		ctx.stderr("Voir `sqlnest --help`.");
		return 2;
	}

	const env = ctx.env ?? {};
	const baseUrl = env.SQLNEST_API_URL ?? DEFAULT_API_URL;
	const frontendUrl = env.SQLNEST_FRONTEND_URL ?? DEFAULT_FRONTEND_URL;

	// ─── Résolution de la DSN locale à servir (C.13) ─────────────────
	// Un même install CLI (une seule keypair) peut manager plusieurs DSN
	// locales via `add-connection`. On envoie le nom choisi au backend :
	// le fingerprint effectif est `SHA256(pubkey || "|" || cliConnectionName)`,
	// donc chaque (CLI, DSN) devient une db_connection distincte côté
	// serveur — sinon les 2 DSN collapse toutes sur la même db_connection.
	let cliConnectionName: string | null;
	try {
		cliConnectionName = await resolveCliConnectionName(
			parsed.values.connection,
			ctx
		);
	} catch (err) {
		ctx.stderr(`sqlnest connect: ${(err as Error).message}`);
		return 2;
	}

	let sessionId: string;
	let token: string;
	let connectionName: string;
	try {
		// ─── CI mode via --token ──────────────────────────────────────
		if (parsed.values.token) {
			if (!parsed.values.name) {
				ctx.stderr(
					"sqlnest connect --token: `--name <label>` est requis en CI."
				);
				return 2;
			}
			const connectWithTokenFn =
				ctx.io.connectWithTokenFn ?? defaultConnectWithToken;
			const result = await connectWithTokenFn({
				baseUrl,
				bearerToken: parsed.values.token,
				deviceName: parsed.values.name,
				cliConnectionName
			});
			ctx.stdout(
				`✓ Pairing CI OK : « ${result.connectionName} » — ${result.tunnelId}`
			);
			sessionId = result.tunnelId;
			token = result.sessionToken;
			connectionName = result.connectionName;
		} else {
			// ─── Device flow interactif ─────────────────────────────────
			const connectFn = ctx.io.connectFn ?? defaultConnect;
			const result = await connectFn({
				baseUrl,
				frontendUrl,
				openBrowserOnDisplay: parsed.values["no-browser"] !== true,
				cliConnectionName,
				onCodeDisplayed: (info) => {
					ctx.stdout("▲ SQLNest — device pairing");
					if (cliConnectionName) {
						ctx.stdout(`  DSN    : ${cliConnectionName}`);
					}
					ctx.stdout(`  Visite : ${info.connectUrl}`);
					ctx.stdout(`  Code   : ${info.code}`);
					ctx.stdout(
						`  Expire : ${new Date(info.expiresAt).toLocaleTimeString()}`
					);
					ctx.stdout("");
					ctx.stdout("En attente d'approbation…");
				}
			});
			ctx.stdout(
				`✓ Pairing OK : « ${result.connectionName} » — ${result.tunnelId}`
			);
			sessionId = result.tunnelId;
			token = result.sessionToken;
			connectionName = result.connectionName;
		}
	} catch (err) {
		return handleConnectError(err, ctx.stderr);
	}

	// ─── Serve loop : ouvre le WS et bloque jusqu'à SIGINT ────────────
	ctx.stdout("");
	ctx.stdout(`▶ Tunnel actif — Ctrl-C pour arrêter.`);
	const serveTunnelFn = ctx.io.serveTunnelFn ?? defaultServeTunnel;
	try {
		return await serveTunnelFn({
			baseUrl,
			sessionId,
			token,
			connectionName,
			...(ctx.env ? { env: ctx.env } : {}),
			onEvent: (event) => {
				if (event.kind === "op-received") {
					ctx.stdout(`  ← ${event.op}`);
				} else if (event.kind === "op-completed") {
					if (event.ok) {
						ctx.stdout(`  → ${event.op} ✓`);
					} else {
						// Sortie sur stderr pour rester grep-able / redirigeable.
						// Le message d'erreur (ex `connect ECONNREFUSED 127.0.0.1:5432`
						// quand Postgres est down) évite le classique "✗ opaque" qui
						// force le user à ouvrir les logs backend pour diagnostiquer.
						const suffix = event.error ? ` — ${event.error}` : "";
						ctx.stderr(`  → ${event.op} ✗${suffix}`);
					}
				} else if (event.kind === "error") {
					ctx.stderr(`  ! ${event.message}`);
				}
			}
		});
	} catch (err) {
		ctx.stderr(`✗ Tunnel : ${(err as Error).message ?? String(err)}`);
		return 1;
	}
}

/**
 * Résout la DSN LOCALE que `sqlnest connect` doit servir cette session (C.13).
 *
 * Ordre de priorité :
 *   1. Flag `--connection <name>` explicite (validé contre le fichier).
 *   2. Si une seule DSN est configurée localement → celle-ci automatiquement.
 *   3. Si ≥2 DSN → prompt interactif "1) apollon  2) delphi > ".
 *   4. Si 0 DSN → `null` (compat CLI legacy pré-C.13 — le tunnel utilisera
 *      les env vars `SQLNEST_PG_URL` ou throw à la résolution).
 *
 * La valeur retournée est envoyée au backend au POST /pairings pour scoper
 * le fingerprint effectif ET utilisée dans le serve loop pour matérialiser
 * la DSN via `resolveLocalConnectionUrl`.
 */
async function resolveCliConnectionName(
	explicit: string | undefined,
	ctx: RunContext
): Promise<string | null> {
	const local = loadLocalConnections();
	const entries = local?.connections ?? [];

	if (explicit) {
		if (entries.length === 0) {
			throw new Error(
				`--connection ${explicit} : aucune DSN configurée localement.\n` +
					"Ajoute-en une : sqlnest add-connection --name " +
					explicit
			);
		}
		const match = entries.find((c) => c.name === explicit);
		if (!match) {
			const names = entries.map((c) => c.name).join(", ");
			throw new Error(
				`--connection ${explicit} : aucune entrée nommée « ${explicit} » ` +
					`dans local-connections.toml. Connues : ${names}`
			);
		}
		return match.name;
	}

	if (entries.length === 0) {
		// Compat legacy — pas de DSN locale = mode env var. Le backend
		// fallback à `hashSha256Hex(pubkey)` seul.
		return null;
	}
	if (entries.length === 1) {
		return entries[0]?.name ?? null;
	}

	// ≥2 DSN : prompt select interactif (flèches ↑↓, Enter valide, Ctrl-C
	// annule via `ExitPromptError`). Sur non-TTY (CI, stdin pipé), inquirer
	// throw → fallback silencieux sur le prompt numéroté classique.
	const prompter = ctx.io.prompter ?? defaultPrompter();
	try {
		if (process.stdin.isTTY === true) {
			return await prompter.select({
				message: "DSN à servir",
				choices: entries.map((c) => ({ value: c.name, label: c.name }))
			});
		}
		// Fallback non-TTY : prompt numéroté ligne par ligne.
		ctx.stdout("▲ Plusieurs DSN locales configurées :");
		for (let i = 0; i < entries.length; i++) {
			ctx.stdout(`  ${i + 1}) ${entries[i]?.name}`);
		}
		while (true) {
			const raw = await prompter.line("Choisis la DSN à servir [1] : ");
			const trimmed = raw.trim();
			const idx = trimmed === "" ? 1 : Number.parseInt(trimmed, 10);
			if (Number.isInteger(idx) && idx >= 1 && idx <= entries.length) {
				return entries[idx - 1]?.name ?? null;
			}
			ctx.stderr(
				`Réponse invalide — tape un numéro entre 1 et ${entries.length}.`
			);
		}
	} finally {
		prompter.close?.();
	}
}

function runLogout(args: string[], ctx: Omit<RunContext, "env">): number {
	let parsed: {
		values: {
			all?: boolean;
			tunnel?: string;
		};
	};
	try {
		parsed = parseArgs({
			args,
			options: {
				all: { type: "boolean" },
				tunnel: { type: "string" }
			},
			strict: true,
			allowPositionals: false
		});
	} catch (err) {
		ctx.stderr(`sqlnest logout: usage invalide — ${(err as Error).message}`);
		return 2;
	}

	if (!parsed.values.all && !parsed.values.tunnel) {
		ctx.stderr("sqlnest logout: spécifie `--all` OU `--tunnel <id>`.");
		return 2;
	}

	try {
		const logoutFn = ctx.io.logoutFn ?? defaultLogout;
		const result = logoutFn({
			...(parsed.values.all ? { all: true } : {}),
			...(parsed.values.tunnel ? { tunnelId: parsed.values.tunnel } : {})
		});
		ctx.stdout(
			`✓ ${result.removed} tunnel${result.removed === 1 ? "" : "s"} retiré${result.removed === 1 ? "" : "s"} de la config locale`
		);
		return 0;
	} catch (err) {
		ctx.stderr(`sqlnest logout: erreur — ${(err as Error).message}`);
		return 1;
	}
}

async function runPing(args: string[], ctx: RunContext): Promise<number> {
	let parsed: { values: { tunnel?: string } };
	try {
		parsed = parseArgs({
			args,
			options: { tunnel: { type: "string" } },
			strict: true,
			allowPositionals: false
		});
	} catch (err) {
		ctx.stderr(`sqlnest ping: usage invalide — ${(err as Error).message}`);
		return 2;
	}
	const tunnelName = parsed.values.tunnel;
	if (!tunnelName) {
		ctx.stderr(
			"sqlnest ping: `--tunnel <name>` est requis. Ex: sqlnest ping --tunnel prod"
		);
		return 2;
	}

	try {
		const pingFn = ctx.io.pingFn ?? defaultPing;
		const res = await pingFn({
			tunnelName,
			...(ctx.env ? { env: ctx.env } : {})
		});
		ctx.stdout(
			`✓ Ping OK — ${res.latencyMs} ms (source: ${res.source})${
				res.serverVersion ? ` — PG ${res.serverVersion}` : ""
			}`
		);
		ctx.stdout(
			`  ${res.collectionCount} collections détectées à l'introspection`
		);
		return 0;
	} catch (err) {
		if (err instanceof LocalConnectionNotFoundError) {
			ctx.stderr(`✗ ${err.message}`);
			return 1;
		}
		ctx.stderr(`✗ Ping échec : ${(err as Error).message ?? String(err)}`);
		return 1;
	}
}

interface RunSyncContext {
	readonly stdout: (line: string) => void;
	readonly stderr: (line: string) => void;
	readonly io: CliIO;
}

async function runAddConnection(
	args: string[],
	ctx: RunSyncContext
): Promise<number> {
	let parsed: {
		values: { name?: string; force?: boolean; url?: string };
	};
	try {
		parsed = parseArgs({
			args,
			options: {
				name: { type: "string" },
				force: { type: "boolean" },
				url: { type: "string" }
			},
			strict: true,
			allowPositionals: false
		});
	} catch (err) {
		ctx.stderr(
			`sqlnest add-connection: usage invalide — ${(err as Error).message}`
		);
		return 2;
	}
	const name = parsed.values.name;
	if (!name) {
		ctx.stderr(
			"sqlnest add-connection: `--name <label>` est requis. Ex: sqlnest add-connection --name apollon"
		);
		return 2;
	}

	const addFn = ctx.io.addConnectionFn ?? defaultAddConnection;
	const prompter = ctx.io.prompter ?? defaultPrompter();
	try {
		await addFn({
			name,
			...(parsed.values.force ? { force: true } : {}),
			...(parsed.values.url ? { url: parsed.values.url } : {}),
			prompter,
			stdout: ctx.stdout
		});
		return 0;
	} catch (err) {
		if (err instanceof AddConnectionError) {
			if (err.kind === "cancelled") {
				ctx.stderr(`✗ ${err.message}`);
				return 1;
			}
			ctx.stderr(`✗ ${err.message}`);
			return 2;
		}
		ctx.stderr(`✗ ${(err as Error).message ?? String(err)}`);
		return 1;
	} finally {
		// Le prompter par défaut détient une readline.Interface — la close
		// permet au process de se terminer naturellement (sans SIGKILL).
		prompter.close?.();
	}
}

async function runRevokeConnection(
	args: string[],
	ctx: RunSyncContext
): Promise<number> {
	let parsed: {
		values: { name?: string; yes?: boolean };
	};
	try {
		parsed = parseArgs({
			args,
			options: {
				name: { type: "string" },
				yes: { type: "boolean" }
			},
			strict: true,
			allowPositionals: false
		});
	} catch (err) {
		ctx.stderr(
			`sqlnest revoke-connection: usage invalide — ${(err as Error).message}`
		);
		return 2;
	}
	const name = parsed.values.name;
	if (!name) {
		ctx.stderr(
			"sqlnest revoke-connection: `--name <label>` est requis. Ex: sqlnest revoke-connection --name apollon"
		);
		return 2;
	}

	const revokeFn = ctx.io.revokeConnectionFn ?? defaultRevokeConnection;
	const prompter = ctx.io.prompter ?? defaultPrompter();
	try {
		await revokeFn({
			name,
			...(parsed.values.yes ? { yes: true } : {}),
			prompter,
			stdout: ctx.stdout
		});
		return 0;
	} catch (err) {
		if (err instanceof RevokeConnectionError) {
			ctx.stderr(`✗ ${err.message}`);
			return 1;
		}
		ctx.stderr(`✗ ${(err as Error).message ?? String(err)}`);
		return 1;
	} finally {
		prompter.close?.();
	}
}

function handleConnectError(
	err: unknown,
	stderr: (line: string) => void
): number {
	if (err instanceof ConnectError) {
		switch (err.kind) {
			case "timeout":
				stderr(
					"✗ Timeout — 5 minutes se sont écoulées sans approbation. Relance `sqlnest connect`."
				);
				return 1;
			case "expired":
				stderr(
					"✗ Code expiré côté serveur. Relance `sqlnest connect` pour un nouveau code."
				);
				return 1;
			case "consumed":
				stderr(
					"✗ Code déjà consommé (autre session ?). Relance `sqlnest connect`."
				);
				return 1;
		}
	}
	if (err instanceof ApiClientError) {
		stderr(`✗ Erreur backend : HTTP ${err.statusCode} — ${err.message}`);
		return 1;
	}
	stderr(`✗ Erreur : ${(err as Error).message ?? String(err)}`);
	return 1;
}

const HELP_TEXT = `sqlnest — CLI SQLNest (tunnel local vers ta DB Postgres).

Usage :
  sqlnest connect                          Device flow interactif (menu ↑↓ si ≥2 DSN)
  sqlnest connect --connection <name>      Force la DSN locale à servir (skip menu)
  sqlnest connect --no-browser             Idem, sans ouverture browser
  sqlnest connect --token <sn> --name <n>  CI mode (Bearer sn_...)
  sqlnest logout --all                     Retire tous les tunnels locaux
  sqlnest logout --tunnel <id>             Retire un tunnel local
  sqlnest ping --tunnel <name>             Ping local DSN (diagnostic)
  sqlnest add-connection --name <n>        Ajoute une DSN locale (prompts interactifs)
  sqlnest add-connection --name <n> --url <dsn>  DSN inline (⚠ visible dans ps aux / historique shell)
  sqlnest add-connection --name <n> --force  Écrase sans demander confirmation
  sqlnest revoke-connection --name <n>     Retire une DSN locale (avec confirm)
  sqlnest revoke-connection --name <n> --yes  Skip la confirmation
  sqlnest --help                           Affiche cette aide
  sqlnest --version                        Affiche la version

Env vars :
  SQLNEST_API_URL       URL du backend      (défaut: ${DEFAULT_API_URL})
  SQLNEST_FRONTEND_URL  URL de /connect     (défaut: ${DEFAULT_FRONTEND_URL})
  SQLNEST_CONFIG_DIR    Dossier config      (défaut: ~/.sqlnest)
  SQLNEST_PG_URL_<NAME>  DSN Postgres jetable (override du fichier local pour un tunnel donné)
`;
