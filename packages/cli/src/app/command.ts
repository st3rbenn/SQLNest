import { type ParseArgsOptionsConfig, parseArgs } from "node:util";
import type { CliContext } from "./context";

/**
 * Une sous-commande `sqlnest <name>`. Le registre (`registry.ts`) les liste ;
 * le dispatch et l'aide en sont dérivés.
 */
export interface CommandDefinition {
	readonly name: string;
	/** Lignes de l'aide : usage, description. */
	readonly help: readonly (readonly [string, string])[];
	/** Code de sortie : 0 succès, 1 erreur, 2 usage invalide. */
	readonly run: (args: string[], ctx: CliContext) => Promise<number> | number;
}

export function defineCommand(
	definition: CommandDefinition
): CommandDefinition {
	return definition;
}

/**
 * Options d'une commande, sans argument positionnel. Usage invalide :
 * message sur stderr et `undefined` — la commande sort en 2.
 */
export function parseCommandArgs<const T extends ParseArgsOptionsConfig>(
	ctx: CliContext,
	command: string,
	args: string[],
	options: T,
	{ seeHelp = false }: { readonly seeHelp?: boolean } = {}
) {
	try {
		return parseArgs({ args, options, strict: true, allowPositionals: false })
			.values;
	} catch (err) {
		ctx.stderr(
			`sqlnest ${command}: usage invalide — ${(err as Error).message}`
		);
		if (seeHelp) ctx.stderr("Voir `sqlnest --help`.");
		return undefined;
	}
}

/**
 * Comme `parseCommandArgs`, avec au plus `max` arguments positionnels :
 * `sqlnest link-project <connexion> <dossier>`.
 */
export function parseCommandLine<const T extends ParseArgsOptionsConfig>(
	ctx: CliContext,
	command: string,
	args: string[],
	options: T,
	max: number
) {
	try {
		const parsed = parseArgs({
			args,
			options,
			strict: true,
			allowPositionals: true
		});
		const extra = parsed.positionals[max];
		if (extra !== undefined) throw new Error(`argument en trop « ${extra} »`);
		return parsed;
	} catch (err) {
		ctx.stderr(
			`sqlnest ${command}: usage invalide — ${(err as Error).message}`
		);
		return undefined;
	}
}
