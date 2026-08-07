/**
 * `sqlnest revoke-connection --name <n>` — retire une entrée du fichier
 * `~/.sqlnest/local-connections.toml`. Prompt de confirmation par défaut
 * (skip avec `--yes`).
 *
 * NB : cette commande NE touche PAS au backend (pas de révocation du
 * pairing / session_token). Pour ça, `sqlnest logout --tunnel <id>` ou le
 * dashboard web. Ici on retire UNIQUEMENT la DSN locale.
 */

import {
	loadLocalConnections,
	removeLocalConnection
} from "../local-connections";
import type { Prompter } from "../prompts";

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
