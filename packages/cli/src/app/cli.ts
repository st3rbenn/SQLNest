/**
 * Point d'entrée `sqlnest` : construit le contexte, dispatche vers la
 * sous-commande du registre, rend l'aide et la version.
 *
 * ─── Design ───────────────────────────────────────────────────────────
 * `runCli(argv, io)` est le point d'entrée testable. Toutes les I/O
 * (stdout, stderr, env vars, services des commandes) sont injectables. Le
 * vrai `bin` fait juste `runCli(process.argv.slice(2))`. Une commande se
 * déclare dans `commands/` et s'inscrit dans `registry.ts`.
 *
 * ─── Env vars ─────────────────────────────────────────────────────────
 *   SQLNEST_CONFIG_DIR    (défaut: ~/.sqlnest — utile pour tests)
 *
 * L'URL du backend / frontend est bakée AU BUILD TIME (`build-info.ts`).
 *
 * ─── Exit codes ───────────────────────────────────────────────────────
 *   0 : succès
 *   1 : erreur runtime (backend down, timeout, sig invalide…)
 *   2 : usage invalide (args manquants / inconnus)
 */

import { addConnection } from "../commands/add-connection";
import { connect } from "../commands/connect/device-flow";
import { connectWithToken } from "../commands/connect/token";
import { listConnections } from "../commands/list-connections";
import { logout } from "../commands/logout";
import { ping } from "../commands/ping";
import { revokeConnection } from "../commands/revoke-connection";
import { probeConnection } from "../services/engine";
import { serveTunnel } from "../tunnel/serve";
import { defaultPrompter, type Prompter } from "../ui/prompts";
import { CLI_VERSION } from "./build-info";
import type { CliContext, CliServices } from "./context";
import { renderHelp } from "./help";
import { COMMANDS } from "./registry";

export interface CliIO {
	readonly stdout?: (line: string) => void;
	readonly stderr?: (line: string) => void;
	readonly env?: NodeJS.ProcessEnv;
	/** Services remplacés (test). */
	readonly services?: Partial<CliServices>;
	// Raccourcis historiques, équivalents à `services` (test).
	readonly connectFn?: CliServices["connect"];
	readonly connectWithTokenFn?: CliServices["connectWithToken"];
	readonly logoutFn?: CliServices["logout"];
	readonly pingFn?: CliServices["ping"];
	readonly serveTunnelFn?: CliServices["serveTunnel"];
	readonly addConnectionFn?: CliServices["addConnection"];
	readonly listConnectionsFn?: CliServices["listConnections"];
	readonly revokeConnectionFn?: CliServices["revokeConnection"];
	readonly prompter?: Prompter;
}

function servicesFrom(io: CliIO): CliServices {
	const prompter = io.prompter;
	return {
		connect: io.connectFn ?? connect,
		connectWithToken: io.connectWithTokenFn ?? connectWithToken,
		serveTunnel: io.serveTunnelFn ?? serveTunnel,
		logout: io.logoutFn ?? logout,
		ping: io.pingFn ?? ping,
		addConnection: io.addConnectionFn ?? addConnection,
		listConnections: io.listConnectionsFn ?? listConnections,
		revokeConnection: io.revokeConnectionFn ?? revokeConnection,
		probeConnection,
		prompter: prompter !== undefined ? () => prompter : defaultPrompter,
		...io.services
	};
}

/** Retourne l'exit code (0 succès, 1 erreur, 2 usage). Ne process.exit
 * jamais — le caller décide (le vrai bin appellera `process.exit(code)`
 * en fin). */
export async function runCli(argv: string[], io: CliIO = {}): Promise<number> {
	const stdout =
		io.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
	const stderr =
		io.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));

	if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
		stdout(renderHelp(COMMANDS));
		return 0;
	}
	if (argv[0] === "--version" || argv[0] === "-v") {
		stdout(CLI_VERSION);
		return 0;
	}

	const [name, ...rest] = argv;
	const command = COMMANDS.find((c) => c.name === name);
	if (command === undefined) {
		stderr(`sqlnest: commande inconnue « ${name} »`);
		stderr(renderHelp(COMMANDS));
		return 2;
	}
	const ctx: CliContext = {
		stdout,
		stderr,
		env: io.env ?? process.env,
		services: servicesFrom(io)
	};
	return command.run(rest, ctx);
}
