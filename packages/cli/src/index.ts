/**
 * `@sqlnest/cli` — module racine (API programmatique).
 *
 * Expose : crypto (Ed25519 keypair, AES-256-GCM privkey chiffrée, load/save
 * `config.toml` avec perms 0600), device flow client (`runCli(argv)` dispatch
 * subcommand — `connect`, `connect --token`, `logout` — API client fetch,
 * ouverture browser best-effort), et wrappers engine + WS.
 */

export type { CliIO } from "./app/cli";
export { runCli } from "./app/cli";
export type { CliServices } from "./app/context";
export type {
	CodeDisplayInfo,
	ConnectFailureReason,
	ConnectOptions,
	ConnectResult
} from "./commands/connect/device-flow";
export {
	ConnectError,
	connect,
	POLL_INTERVAL_MS,
	POLL_TIMEOUT_MS
} from "./commands/connect/device-flow";
export type { ConnectTokenOptions } from "./commands/connect/token";
export { connectWithToken } from "./commands/connect/token";
export type { LogoutOptions, LogoutResult } from "./commands/logout";
export { logout } from "./commands/logout";
export type { PingCommandOptions, PingCommandResult } from "./commands/ping";
export { ping } from "./commands/ping";
export type {
	ApiClient,
	AuthenticateResult,
	CreatePairingResult,
	PairingStatus,
	StatusPairingResult
} from "./services/api-client";
export { ApiClientError, createApiClient } from "./services/api-client";
export type { SqlnestConfig, TunnelEntry } from "./services/config";
export {
	assertConfigPerms,
	CONFIG_VERSION,
	ensureConfigDir,
	getConfigDir,
	getConfigPath,
	loadConfig,
	MAX_CONFIG_PERMS,
	saveConfig
} from "./services/config";
export type { Keypair } from "./services/crypto";
export {
	decryptPrivateKey,
	encryptPrivateKey,
	generateKeypair,
	generateSalt,
	signMessage
} from "./services/crypto";
export type { TunnelPingResult } from "./services/engine";
export {
	introspectTunnel,
	openConnectionForTunnel,
	pingTunnel,
	runSnqlOnTunnel
} from "./services/engine";
export type {
	ConnectionDiagnostics,
	LocalConnectionEntry,
	LocalConnectionsFile
} from "./services/local-connections";
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
} from "./services/local-connections";
export type {
	RemoteOp,
	RemoteResult,
	TunnelWsClient,
	TunnelWsClientOptions,
	WsSocket
} from "./tunnel/ws-client";
export { createTunnelWsClient } from "./tunnel/ws-client";
export { openBrowser } from "./ui/open-browser";
