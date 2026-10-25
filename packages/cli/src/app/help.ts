import type { CommandDefinition } from "./command";

const HEADER = "sqlnest — CLI SQLNest (tunnel local vers ta DB Postgres).";

const GLOBAL_HELP: readonly (readonly [string, string])[] = [
	["sqlnest --help", "Affiche cette aide"],
	["sqlnest --version", "Affiche la version"]
];

/** Aide de `sqlnest --help`, dérivée des commandes du registre. */
export function renderHelp(commands: readonly CommandDefinition[]): string {
	const lines = [...commands.flatMap((c) => c.help), ...GLOBAL_HELP].map(
		([usage, description]) => `  ${usage.padEnd(39)}  ${description}`
	);
	return `${[HEADER, "", "Usage :", ...lines].join("\n")}\n`;
}
