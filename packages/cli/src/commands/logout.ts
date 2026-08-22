/**
 * `sqlnest logout [--all|--tunnel <id>]` — retire des tunnels du config
 * local.
 *
 * Sémantique :
 *   - `--all`       : vide `config.tunnels[]`.
 *   - `--tunnel X`  : retire l'entrée dont `id === X`.
 *   - ni l'un ni l'autre : throw (ambiguïté explicite).
 *
 * Note : ce logout est PUREMENT local — il n'appelle pas le backend pour
 * révoquer la session tunnel. La révocation côté serveur passe par le
 * dashboard web ou une future commande `sqlnest revoke <id>` qui
 * appellera `DELETE /api/tunnel-sessions/:id`.
 *
 * Si aucune config n'existe (`loadConfig()` → null), retourne
 * `{ removed: 0 }` — idempotent.
 */

import { loadConfig, saveConfig } from "../config";

export interface LogoutOptions {
	readonly all?: boolean;
	readonly tunnelId?: string;
}

export interface LogoutResult {
	readonly removed: number;
}

export function logout(opts: LogoutOptions): LogoutResult {
	if (!opts.all && !opts.tunnelId) {
		throw new Error(
			"logout: specify `all: true` or `tunnelId`. Usage : `sqlnest logout --all` OR `sqlnest logout --tunnel <id>`."
		);
	}

	const config = loadConfig();
	if (config == null) return { removed: 0 };

	let newTunnels = config.tunnels;
	let removed = 0;
	if (opts.all) {
		removed = config.tunnels.length;
		newTunnels = [];
	} else if (opts.tunnelId) {
		newTunnels = config.tunnels.filter((t) => t.id !== opts.tunnelId);
		removed = config.tunnels.length - newTunnels.length;
	}

	if (removed > 0) {
		saveConfig({ ...config, tunnels: newTunnels });
	}
	return { removed };
}
