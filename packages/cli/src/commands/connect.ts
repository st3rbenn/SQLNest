/**
 * `sqlnest connect` — orchestration du device flow interactif.
 *
 * ─── Contrat ──────────────────────────────────────────────────────────
 *   1. Init config si absente (fresh salt + keypair).
 *   2. POST /api/tunnels/pairings avec pubkey → `{ code, expiresAt, pollUrl }`.
 *   3. Émit `onCodeDisplayed({code, connectUrl, expiresAt})` — le CLI
 *      affiche le code + la URL à visiter côté user.
 *   4. Ouvre le browser sur `connectUrl` (best-effort, désactivable).
 *   5. Poll `/status` toutes les 2s jusqu'à `approved` / `expired`
 *      / `consumed` / timeout local 5min.
 *   6. `approved` → sign(canonical code) → POST /authenticate → reçoit
 *      `{ token, tunnelId, connectionId, expiresAt }`.
 *   7. Ajoute l'entrée dans `config.tunnels[]` + save.
 *   8. Return les infos du tunnel créé.
 *
 * ─── Injection pour test ──────────────────────────────────────────────
 * Tous les I/O (fetch, sleep, clock, browser, callbacks affichage) sont
 * injectables. Les tests unit fournissent des stubs — pas de dépendance
 * réelle sur un backend live ni sur le filesystem (grâce à
 * `SQLNEST_CONFIG_DIR` côté config).
 *
 * ─── Erreurs remontées ────────────────────────────────────────────────
 *   - `ConnectError({ kind: "timeout" })` : polling > 5 min sans
 *     approbation.
 *   - `ConnectError({ kind: "expired" })` : le code a expiré côté backend.
 *   - `ConnectError({ kind: "consumed" })` : quelqu'un d'autre a consommé
 *     le code (course window vraiment rare).
 *   - Les `ApiClientError` non-fatal (network, 5xx) propagent brut ;
 *     un caller CLI peut retry.
 */

import { hostname } from "node:os";
import {
	type ApiClient,
	createApiClient,
	type PairingStatus,
	type StatusPairingResult
} from "../api-client";
import {
	CONFIG_VERSION,
	loadConfig,
	type SqlnestConfig,
	saveConfig,
	type TunnelEntry
} from "../config";
import {
	decryptPrivateKey,
	encryptPrivateKey,
	generateKeypair,
	generateSalt,
	signMessage
} from "../crypto";
import { openBrowser } from "../open-browser";

/** Regex hissée top-level (règle Biome `useTopLevelRegex`). */
const TRAILING_SLASH_RE = /\/+$/;

/** Intervalle de polling entre 2 `/status`. */
export const POLL_INTERVAL_MS = 2_000;

/** Durée max du polling avant abandon local (aligné sur le TTL backend). */
export const POLL_TIMEOUT_MS = 5 * 60 * 1_000;

export type ConnectFailureReason = "timeout" | "expired" | "consumed";

export class ConnectError extends Error {
	readonly kind: ConnectFailureReason;
	constructor(kind: ConnectFailureReason, message?: string) {
		super(message ?? kind);
		this.name = "ConnectError";
		this.kind = kind;
	}
}

export interface ConnectResult {
	readonly tunnelId: string;
	readonly connectionId: string;
	readonly sessionToken: string;
	readonly expiresAt: Date;
	readonly connectionName: string;
}

/** Info affichable côté user à la 1re étape. */
export interface CodeDisplayInfo {
	readonly code: string;
	readonly connectUrl: string;
	readonly expiresAt: Date;
}

export interface ConnectOptions {
	/** URL du backend (ex `https://api.sqlnest.app`). */
	readonly baseUrl: string;
	/** URL du frontend où visiter `/connect` (ex `https://sqlnest.app`). */
	readonly frontendUrl: string;
	/** Ouvrir le browser automatiquement (défaut: true). */
	readonly openBrowserOnDisplay?: boolean;

	// Callbacks — le CLI wrapper affiche via ces hooks.
	readonly onCodeDisplayed?: (info: CodeDisplayInfo) => void;
	readonly onStatus?: (status: PairingStatus) => void;

	// Injection pour test.
	readonly api?: ApiClient;
	readonly sleep?: (ms: number) => Promise<void>;
	readonly now?: () => number;
	readonly openBrowserFn?: (url: string) => Promise<boolean>;
	/** Nom lisible du device (défaut: `os.hostname()`). Utilisé UNIQUEMENT
	 * pour label le tunnel local — le vrai nom vient du deviceName tapé
	 * côté /approve par l'user, remonté via `/status`. */
	readonly deviceLabelFallback?: string;
}

/** Point d'entrée — orchestre le device flow. */
export async function connect(opts: ConnectOptions): Promise<ConnectResult> {
	const api = opts.api ?? createApiClient(opts.baseUrl);
	const sleep = opts.sleep ?? defaultSleep;
	const now = opts.now ?? Date.now;
	const openBrowserFn = opts.openBrowserFn ?? openBrowser;

	// ─── 1. Load/init config, obtenir la privkey en clair ─────────────
	const { config, privateKeyHex } = loadOrInitConfig();

	// ─── 2. POST /pairings ────────────────────────────────────────────
	const pairing = await api.createPairing(config.keypair.public);
	const connectUrl = `${opts.frontendUrl.replace(TRAILING_SLASH_RE, "")}/connect`;
	const expiresAt = new Date(pairing.expiresAt);

	// ─── 3. Émit affichage + open browser ─────────────────────────────
	opts.onCodeDisplayed?.({ code: pairing.code, connectUrl, expiresAt });
	if (opts.openBrowserOnDisplay !== false) {
		// Best-effort — on ignore le résultat, le user peut toujours copier
		// l'URL manuellement.
		await openBrowserFn(connectUrl);
	}

	// ─── 4. Poll /status ──────────────────────────────────────────────
	const start = now();
	let lastStatus: StatusPairingResult | null = null;

	while (now() - start < POLL_TIMEOUT_MS) {
		const status = await api.getPairingStatus(pairing.code);
		opts.onStatus?.(status.status);
		lastStatus = status;

		if (status.status === "expired") {
			throw new ConnectError("expired", "Le code a expiré côté serveur");
		}
		if (status.status === "consumed") {
			throw new ConnectError(
				"consumed",
				"Le code a déjà été consommé (autre session ?)"
			);
		}
		if (status.status === "approved") break;
		await sleep(POLL_INTERVAL_MS);
	}

	if (lastStatus?.status !== "approved") {
		throw new ConnectError(
			"timeout",
			`Timeout après ${Math.round(POLL_TIMEOUT_MS / 1000)}s d'attente`
		);
	}

	// ─── 5. Sign + authenticate ───────────────────────────────────────
	const canonical = pairing.code.replace("-", "");
	const signature = signMessage(canonical, privateKeyHex);
	const auth = await api.authenticatePairing(pairing.code, signature);

	// ─── 6. Persist tunnel entry dans config ──────────────────────────
	const deviceLabel =
		lastStatus.deviceName ?? opts.deviceLabelFallback ?? hostname();
	const tunnelEntry: TunnelEntry = {
		id: auth.tunnelId,
		name: deviceLabel,
		connection_id: auth.connectionId,
		session_token: auth.token,
		expires_at: auth.expiresAt
	};
	saveConfig({
		...config,
		tunnels: [...config.tunnels, tunnelEntry]
	});

	return {
		tunnelId: auth.tunnelId,
		connectionId: auth.connectionId,
		sessionToken: auth.token,
		expiresAt: new Date(auth.expiresAt),
		connectionName: deviceLabel
	};
}

/**
 * Init d'une config fraîche si absente — génère salt + keypair. Sinon
 * décrypte la privkey de la config existante.
 *
 * Isolé pour test / réutilisation par `connect-token`.
 */
export function loadOrInitConfig(): {
	config: SqlnestConfig;
	privateKeyHex: string;
} {
	const existing = loadConfig();
	if (existing != null) {
		const privateKeyHex = decryptPrivateKey(
			existing.keypair.encrypted_private,
			existing.salt
		);
		return { config: existing, privateKeyHex };
	}

	const salt = generateSalt();
	const kp = generateKeypair();
	const config: SqlnestConfig = {
		version: CONFIG_VERSION,
		salt,
		keypair: {
			public: kp.publicHex,
			encrypted_private: encryptPrivateKey(kp.privateHex, salt)
		},
		tunnels: []
	};
	saveConfig(config);
	return { config, privateKeyHex: kp.privateHex };
}

function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
