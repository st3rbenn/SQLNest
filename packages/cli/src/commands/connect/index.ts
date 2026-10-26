/**
 * `sqlnest connect` — pairing (device flow interactif, ou mode CI avec
 * `--token`), puis tunnel jusqu'à Ctrl-C.
 */

import { homedir } from "node:os";
import { API_URL, FRONTEND_URL } from "../../app/build-info";
import {
	defineCommand,
	parseCommandLine,
	positionalOrOption
} from "../../app/command";
import type { CliContext } from "../../app/context";
import { ApiClientError } from "../../services/api-client";
import { loadConfig } from "../../services/config";
import {
	describeConnection,
	ENGINE_LABELS,
	parseConnectionString
} from "../../services/connection-strings";
import {
	type DiscoveredServer,
	type Discovery,
	serverFor
} from "../../services/discovery";
import { resolveLocalConnectionUrl } from "../../services/local-connections";
import type { Prompter } from "../../ui/prompts";
import { createSpinner, type SpinnerHandle } from "../../ui/spinner";
import { AddConnectionError, discoveryTools } from "../add-connection";
import { ensureRunning } from "../add-connection/discovered";
import { describeFailure } from "../add-connection/errors";
import { LinkProjectError, linkConnection } from "../link-project/link";
import { chooseConnection } from "./choose";
import { ConnectError } from "./device-flow";

export { describeTunnelStatus } from "./choose";

export const connectCommand = defineCommand({
	name: "connect",
	help: [
		[
			"sqlnest connect",
			"Sert une connexion : celle du projet relié, sinon menu"
		],
		["sqlnest connect <name>", "Sert cette connexion, sans menu"],
		["sqlnest connect --no-browser", "Idem, sans ouvrir le navigateur"],
		["sqlnest connect --token <sn> --name <n>", "Mode CI (Bearer sn_...)"]
	],
	run: runConnect
});

async function runConnect(args: string[], ctx: CliContext): Promise<number> {
	const parsed = parseCommandLine(
		ctx,
		"connect",
		args,
		{
			token: { type: "string" },
			name: { type: "string" },
			connection: { type: "string" },
			"no-browser": { type: "boolean" }
		},
		1,
		{ seeHelp: true }
	);
	if (parsed === undefined) return 2;
	const { values } = parsed;
	const explicit = positionalOrOption(ctx, "connect", parsed.positionals[0], {
		flag: "--connection",
		value: values.connection
	});
	if (explicit === undefined) return 2;

	const baseUrl = API_URL;
	const frontendUrl = FRONTEND_URL;

	// ─── Résolution de la connexion locale à servir ────────────────────
	// Un même install CLI (une seule keypair) peut manager plusieurs
	// connexions locales via `add-connection`. On envoie le nom choisi au
	// backend : le fingerprint effectif est `SHA256(pubkey || "|" || cliConnectionName)`,
	// donc chaque (CLI, connexion) devient une db_connection distincte côté
	// serveur — sinon elles collapsent toutes sur la même db_connection.
	const interactive = process.stdin.isTTY === true;
	const tools = discoveryTools(ctx);
	let discovery: Promise<Discovery> | undefined;
	const discoverOnce = (): Promise<Discovery> => {
		discovery ??= tools.discover(process.cwd());
		return discovery;
	};
	const prompter = ctx.services.prompter();
	let cliConnectionName: string | null;
	try {
		cliConnectionName = await chooseConnection({
			...(explicit.value !== undefined ? { explicit: explicit.value } : {}),
			cwd: process.cwd(),
			home: homedir(),
			interactive,
			tunnels: loadConfig()?.tunnels ?? [],
			discover: discoverOnce,
			addConnection: async (database) =>
				(
					await ctx.services.addConnection({
						...(database !== undefined ? { database, offerLink: false } : {}),
						discover: discoverOnce,
						test: ctx.services.probeConnection,
						listDatabases: tools.listDatabases,
						startServer: tools.startServer,
						interactive,
						prompter,
						stdout: ctx.stdout
					})
				).name,
			link: async (name, detection) => {
				await linkConnection({
					name,
					detection,
					apply: true,
					probe: ctx.services.probeConnection,
					interactive,
					prompter,
					stdout: ctx.stdout
				});
			},
			prompter,
			stdout: ctx.stdout,
			stderr: ctx.stderr
		});
		if (interactive && cliConnectionName !== null) {
			await checkBeforePairing(cliConnectionName, ctx, {
				prompter,
				discover: discoverOnce,
				startServer: tools.startServer
			});
		}
	} catch (err) {
		if (err instanceof AddConnectionError || err instanceof LinkProjectError) {
			ctx.stderr(`✗ ${err.message}`);
			return err.kind === "invalid-input" ? 2 : 1;
		}
		if ((err as Error).name === "ExitPromptError") {
			ctx.stderr("✗ Annulé");
			return 130;
		}
		ctx.stderr(`sqlnest connect: ${(err as Error).message}`);
		return 2;
	} finally {
		prompter.close?.();
	}

	let sessionId: string;
	let token: string;
	let connectionName: string;
	try {
		// ─── CI mode via --token ──────────────────────────────────────
		if (values.token) {
			if (!values.name) {
				ctx.stderr(
					"sqlnest connect --token: `--name <label>` est requis en CI."
				);
				return 2;
			}
			const result = await ctx.services.connectWithToken({
				baseUrl,
				bearerToken: values.token,
				deviceName: values.name,
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
			// Spinner Braille avec transitions in-place. Fallback plain-log
			// préfixé `[sqlnest]` si non-TTY (CI, pipe, redirection) pour que
			// `sqlnest connect | tee log.txt` et GHA restent lisibles.
			let spinner: SpinnerHandle | null = null;
			try {
				const result = await ctx.services.connect({
					baseUrl,
					frontendUrl,
					openBrowserOnDisplay: values["no-browser"] !== true,
					cliConnectionName,
					onCodeDisplayed: (info) => {
						ctx.stdout("▲ SQLNest — device pairing");
						if (cliConnectionName) {
							ctx.stdout(
								`  Connexion : ${describeServed(cliConnectionName, ctx.env)}`
							);
						}
						ctx.stdout(`  Visite    : ${info.connectUrl}`);
						ctx.stdout(`  Code      : ${info.code}`);
						ctx.stdout(
							`  Expire    : ${new Date(info.expiresAt).toLocaleTimeString()}`
						);
						ctx.stdout("");
						spinner = createSpinner("En attente d'approbation…");
					},
					onStatus: (status) => {
						if (status === "approved" && spinner !== null) {
							spinner.update("Approuvé — ouverture du tunnel…");
						}
					}
				});
				if (result.resumed) {
					// Auto-resume : `onCodeDisplayed` n'est pas appelé, pas
					// de spinner à arrêter.
					ctx.stdout(
						`↻ Tunnel repris : « ${result.connectionName} » — ${result.tunnelId}`
					);
				} else if (spinner !== null) {
					(spinner as SpinnerHandle).succeed(
						`Pairing OK : « ${result.connectionName} » — ${result.tunnelId}`
					);
				} else {
					ctx.stdout(
						`✓ Pairing OK : « ${result.connectionName} » — ${result.tunnelId}`
					);
				}
				sessionId = result.tunnelId;
				token = result.sessionToken;
				connectionName = result.connectionName;
			} catch (err) {
				// Nettoie la ligne du spinner avant que le handler stderr
				// print le message d'erreur — sinon le `⠋ En attente…`
				// reste collé devant l'erreur. Cast explicite : le TS narrow
				// tombe à `never` sur le catch parce que l'assignation
				// `spinner = createSpinner(...)` vit dans un callback closure
				// (`onCodeDisplayed`) que le flow-analyzer ne peut pas prouver
				// exécuté avant l'await. La déclaration `spinner: SpinnerHandle
				// | null` reste la vérité.
				(spinner as SpinnerHandle | null)?.stop();
				throw err;
			}
		}
	} catch (err) {
		return handleConnectError(err, ctx.stderr);
	}

	// ─── Serve loop : ouvre le WS et bloque jusqu'à SIGINT ────────────
	ctx.stdout("");
	ctx.stdout(`▶ Tunnel actif — Ctrl-C pour arrêter.`);
	try {
		return await ctx.services.serveTunnel({
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

/** `nom — PostgreSQL · user@hôte:port/base`, sans secret ; le nom seul si l'URL est illisible. */
function describeServed(
	name: string,
	env: NodeJS.ProcessEnv | undefined
): string {
	try {
		const c = parseConnectionString(resolveLocalConnectionUrl(name, env));
		return c !== undefined
			? `${name} — ${ENGINE_LABELS[c.engine]} · ${describeConnection(c)}`
			: name;
	} catch {
		return name;
	}
}

/**
 * Avant le pairing, la base répond-elle ? Sinon, un conteneur arrêté qui la
 * sert est proposé au démarrage ; à défaut, un avertissement — le tunnel
 * s'ouvre quand même.
 */
async function checkBeforePairing(
	name: string,
	ctx: CliContext,
	tools: {
		readonly prompter: Prompter;
		readonly discover: () => Promise<Discovery>;
		readonly startServer: (
			server: DiscoveredServer,
			url: string
		) => Promise<void>;
	}
): Promise<void> {
	let url: string | undefined;
	try {
		url = resolveLocalConnectionUrl(name, ctx.env);
		await ctx.services.waitForDatabase(url, 0);
		return;
	} catch (err) {
		const parsed = url !== undefined ? parseConnectionString(url) : undefined;
		const server =
			parsed !== undefined
				? serverFor(parsed, await tools.discover())
				: undefined;
		if (server !== undefined && !server.running && url !== undefined) {
			await ensureRunning(
				{
					prompter: tools.prompter,
					stdout: ctx.stdout,
					startServer: tools.startServer
				},
				server,
				url
			);
			return;
		}
		ctx.stderr(
			`⚠ Base injoignable : ${describeFailure(err)} — le tunnel s'ouvre quand même.`
		);
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
