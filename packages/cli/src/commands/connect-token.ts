/**
 * `sqlnest connect --token sn_...` — mode CI/scripts.
 *
 * Différences avec le device flow (`connect.ts`) :
 *   - Pas de polling — auth immédiate via Bearer.
 *   - Pas de browser — le CLI est appelé depuis un job.
 *   - `deviceName` est REQUIS (le user n'a pas d'UI pour le fournir).
 *
 * Le token Bearer doit être un `sn_<64 hex>` généré via le dashboard
 * `/api/api-tokens`. La pubkey Ed25519 du CLI est envoyée en body pour
 * signer les futures frames WS (Bloc 7).
 */

import { hostname } from "node:os";
import { type ApiClient, createApiClient } from "../api-client";
import { saveConfig, type TunnelEntry } from "../config";
import type { ConnectResult } from "./connect";
import { loadOrInitConfig } from "./connect";

export interface ConnectTokenOptions {
	readonly baseUrl: string;
	/** Clair `sn_<64 hex>` — passé par le user via `--token`. */
	readonly bearerToken: string;
	/** Nom explicite requis en CI (pas d'UI de sélection). */
	readonly deviceName: string;

	// Injection pour test.
	readonly api?: ApiClient;
	readonly deviceLabelFallback?: string;
}

/**
 * Établit un tunnel via Bearer (CI mode) et persiste l'entrée dans
 * `config.toml`. Retourne les mêmes infos que `connect`.
 */
export async function connectWithToken(
	opts: ConnectTokenOptions
): Promise<ConnectResult> {
	const api = opts.api ?? createApiClient(opts.baseUrl);

	// Init/load config (fresh keypair si première fois).
	const { config } = loadOrInitConfig();

	// Auth immédiate — pas de polling, pas de browser.
	const auth = await api.authenticateWithToken(
		opts.bearerToken,
		config.keypair.public,
		opts.deviceName
	);

	// Le deviceName choisi par le user en CI est source de vérité pour le
	// label local (contrairement au device flow où on prend le nom saisi
	// dans /connect côté browser).
	const label = opts.deviceName || opts.deviceLabelFallback || hostname();
	const entry: TunnelEntry = {
		id: auth.tunnelId,
		name: label,
		connection_id: auth.connectionId,
		session_token: auth.token,
		expires_at: auth.expiresAt
	};
	saveConfig({ ...config, tunnels: [...config.tunnels, entry] });

	return {
		tunnelId: auth.tunnelId,
		connectionId: auth.connectionId,
		sessionToken: auth.token,
		expiresAt: new Date(auth.expiresAt),
		connectionName: label
	};
}
