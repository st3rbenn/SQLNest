/**
 * `sqlnest revoke-connection --name <n>` — retire une entrée du fichier
 * `~/.sqlnest/local-connections.toml`. Prompt de confirmation par défaut
 * (skip avec `--yes`).
 *
 * NB : cette commande NE touche PAS au backend (pas de révocation du
 * pairing / session_token). Pour ça, `sqlnest logout --tunnel <id>` ou le
 * dashboard web. Ici on retire UNIQUEMENT la DSN locale.
 */

import { defineCommand, parseCommandArgs } from "../app/command";
import {
	loadLocalConnections,
	removeLocalConnection
} from "../services/local-connections";
import type { Prompter } from "../ui/prompts";

export class RevokeConnectionError extends Error {
	readonly kind: "not-found" | "cancelled";
	constructor(kind: RevokeConnectionError["kind"], message: string) {
		super(message);
		this.name = "RevokeConnectionError";
		this.kind = kind;
	}
}

export interface RevokeConnectionOptions {
	readonly name: string;
	readonly yes?: boolean;
	readonly prompter: Prompter;
	readonly stdout: (line: string) => void;
}

export interface RevokeConnectionResult {
	readonly name: string;
}

export async function revokeConnection(
	opts: RevokeConnectionOptions
): Promise<RevokeConnectionResult> {
	const existing = loadLocalConnections();
	const found =
		existing?.connections.some((c) => c.name === opts.name) ?? false;
	if (!found) {
		throw new RevokeConnectionError(
			"not-found",
			`Aucune entrée nommée « ${opts.name} » dans ~/.sqlnest/local-connections.toml`
		);
	}

	if (!opts.yes) {
		const ok = await opts.prompter.confirm(
			`Retirer « ${opts.name} » de ~/.sqlnest/local-connections.toml ? [y/N] `
		);
		if (!ok) {
			throw new RevokeConnectionError("cancelled", "Annulé par l'utilisateur");
		}
	}

	removeLocalConnection(opts.name);
	opts.stdout(`✓ Connection « ${opts.name} » retirée`);
	return { name: opts.name };
}

export const revokeConnectionCommand = defineCommand({
	name: "revoke-connection",
	help: [
		[
			"sqlnest revoke-connection --name <n>",
			"Retire une connexion locale (avec confirmation)"
		],
		["sqlnest revoke-connection --name <n> --yes", "Sans confirmation"]
	],
	async run(args, ctx) {
		const values = parseCommandArgs(ctx, "revoke-connection", args, {
			name: { type: "string" },
			yes: { type: "boolean" }
		});
		if (values === undefined) return 2;
		const name = values.name;
		if (!name) {
			ctx.stderr(
				"sqlnest revoke-connection: `--name <label>` est requis. Ex: sqlnest revoke-connection --name apollon"
			);
			return 2;
		}
		const prompter = ctx.services.prompter();
		try {
			await ctx.services.revokeConnection({
				name,
				...(values.yes ? { yes: true } : {}),
				prompter,
				stdout: ctx.stdout
			});
			return 0;
		} catch (err) {
			ctx.stderr(`✗ ${(err as Error).message ?? String(err)}`);
			return 1;
		} finally {
			prompter.close?.();
		}
	}
});
