/**
 * `@sqlnest/cli` — module racine (API programmatique).
 *
 * ─── Bloc 4 (crypto + config) ─────────────────────────────────────────
 * Ed25519 keypair, AES-256-GCM privkey chiffrée, load/save `config.toml`
 * avec perms 0600.
 *
 * ─── Bloc 5 (device flow client) ──────────────────────────────────────
 * `runCli(argv)` — dispatcher argv → subcommand. Commands `connect`,
 * `connect --token`, `logout`. API client fetch. Ouverture browser
 * best-effort.
 *
 * Le wiring `bin` (script npm executable) attend un build step (esbuild
 * ou tsup) — reporté à un bloc infrastructure ultérieur.
 */

export type {
	ApiClient,
	AuthenticateResult,
	CreatePairingResult,
	PairingStatus,
	StatusPairingResult
} from "./api-client";
export { ApiClientError, createApiClient } from "./api-client";
export type { CliIO } from "./cli";
export { runCli } from "./cli";
export type {
	CodeDisplayInfo,
	ConnectFailureReason,
	ConnectOptions,
	ConnectResult
} from "./commands/connect";
export {
	ConnectError,
	connect,
	POLL_INTERVAL_MS,
	POLL_TIMEOUT_MS
} from "./commands/connect";
export type { ConnectTokenOptions } from "./commands/connect-token";
export { connectWithToken } from "./commands/connect-token";
export type { LogoutOptions, LogoutResult } from "./commands/logout";
export { logout } from "./commands/logout";
export type { PingCommandOptions, PingCommandResult } from "./commands/ping";
export { ping } from "./commands/ping";
export type { SqlnestConfig, TunnelEntry } from "./config";
export {
	assertConfigPerms,
	CONFIG_VERSION,
	ensureConfigDir,
	getConfigDir,
	getConfigPath,
	loadConfig,
	MAX_CONFIG_PERMS,
	saveConfig
} from "./config";
export type { Keypair } from "./crypto";
export {
	decryptPrivateKey,
	encryptPrivateKey,
	generateKeypair,
	generateSalt,
	signMessage
} from "./crypto";
export type { TunnelPingResult } from "./engine";
export {
	introspectTunnel,
	openConnectionForTunnel,
	pingTunnel,
	runSnqlOnTunnel
} from "./engine";
export type {
	ConnectionDiagnostics,
	LocalConnectionEntry,
	LocalConnectionsFile
} from "./local-connections";
export {
	assertLocalConnectionsPerms,
	describeConnectionForDiagnostics,
	getLocalConnectionsPath,
	LOCAL_CONNECTIONS_FILENAME,
	LOCAL_CONNECTIONS_VERSION,
	LocalConnectionNotFoundError,
	loadLocalConnections,
	resolveLocalConnectionUrl,
	saveLocalConnections
} from "./local-connections";
export { openBrowser } from "./open-browser";
export type {
	RemoteOp,
	RemoteResult,
	TunnelWsClient,
	TunnelWsClientOptions,
	WsSocket
} from "./ws-client";
export { createTunnelWsClient } from "./ws-client";
