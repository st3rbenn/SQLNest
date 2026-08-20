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
import {
	computeTunnelFingerprint,
	computeTunnelSchemaChecksum
} from "../engine";
import { openBrowser } from "../open-browser";

/** Regex hissée top-level (règle Biome `useTopLevelRegex`). */
const TRAILING_SLASH_RE = /\/+$/;

/** Intervalle de polling entre 2 `/status`. */
export const POLL_INTERVAL_MS = 2_000;

/** Durée max du polling avant abandon local (aligné sur le TTL backend). */
export const POLL_TIMEOUT_MS = 5 * 60 * 1_000;

/** Marge de sécurité avant `expires_at` — sous ce seuil on considère le
 *  token trop proche de l'expiration pour re-tenter, on fait un fresh
 *  pair pour obtenir un token neuf. Évite les rejets 401 au milieu d'une
 *  session tunnel qui vient tout juste d'être ouverte. */
export const TOKEN_EXPIRY_BUFFER_MS = 60 * 1_000;

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
	/** `true` si le tunnel a été **réutilisé** depuis un token
	 *  `session_token` existant dans `config.tunnels[]` (skip du device
	 *  flow). `false` si device flow interactif complet a été effectué. */
	readonly resumed: boolean;
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
	/** URL du frontend où visiter `/pair` (ex `https://sqlnest.app`). */
	readonly frontendUrl: string;
	/** Ouvrir le browser automatiquement (défaut: true). */
	readonly openBrowserOnDisplay?: boolean;
	/** Nom de la DSN LOCALE à servir cette session (C.13). Envoyé au backend
	 *  au POST /pairings et utilisé pour :
	 *   - scoper le fingerprint effectif SHA256(pubkey || "|" || cliConnectionName)
	 *     → un même install CLI peut servir N DBs distinctes côté serveur
	 *   - identifier la DSN à ouvrir localement via `resolveLocalConnectionUrl`
	 *     dans le serve loop.
	 *  Requis dès que ≥2 `add-connection` sont configurées (sélection UI
	 *  côté CLI). Pour une seule connection locale, tolérable en optionnel. */
	readonly cliConnectionName?: string | null;

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

	// ─── 1.5. Auto-resume — si un tunnel valide existe déjà pour ce
	// `cliConnectionName`, on skip complètement le device flow. Le CLI
	// ré-ouvre juste sa WSS avec le token existant, l'user ne visite
	// jamais /pair après le 1er pairing. Si le token est révoqué
	// serveur-side, l'ouverture WSS échouera et le wrapper CLI pourra
	// re-tenter avec `--force` (à implémenter séparément). ────────────
	const resumable = findResumableTunnel(
		config.tunnels,
		opts.cliConnectionName ?? null,
		now()
	);
	if (resumable !== null) {
		return {
			tunnelId: resumable.id,
			connectionId: resumable.connection_id,
			sessionToken: resumable.session_token,
			expiresAt: new Date(resumable.expires_at),
			connectionName: resumable.connection_name ?? resumable.name,
			resumed: true
		};
	}

	// ─── 2. POST /pairings ────────────────────────────────────────────
	// On envoie `cliConnectionName` : le backend l'utilise pour scoper le
	// fingerprint effectif → un même install CLI peut servir N DBs
	// distinctes côté serveur (C.13).
	// T4/5 : on calcule aussi le db_fingerprint + db_schema_checksum côté
	// CLI (best-effort — silencieux si DSN inaccessible). Envoyés dès le
	// pair pour que le backend détecte au /approve qu'une db_connection
	// existe déjà pour cette DB (multi-CLI reuse) et auto-fill le name
	// côté frontend /pair → user click Approve sans typing.
	const [prePairFingerprint, prePairChecksum] = opts.cliConnectionName
		? await Promise.all([
				computeTunnelFingerprint(opts.cliConnectionName),
				computeTunnelSchemaChecksum(opts.cliConnectionName)
			])
		: [null, null];
	const pairing = await api.createPairing(
		config.keypair.public,
		opts.cliConnectionName ?? null,
		prePairFingerprint,
		prePairChecksum
	);
	// P/2 (ADR-022 D7) : prefill le code dans l'URL — évite à l'user de
	// taper les 8 chars dans PairPage. Le dash n'est pas un caractère
	// réservé RFC 3986, encodeURIComponent le laisse intact.
	const connectUrl = `${opts.frontendUrl.replace(TRAILING_SLASH_RE, "")}/pair?code=${encodeURIComponent(pairing.code)}`;
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
	// T4/1 Step 6 : calcule le fingerprint de l'INSTANCE DB via
	// `computeTunnelFingerprint`. Best-effort — si la DSN n'est pas
	// configurée ou que le server ne répond pas, on continue sans (le
	// backend backfill au prochain connect). L'authenticate reste
	// fonctionnel même sans fingerprint (rétro-compat CLI legacy).
	const dbFingerprint = opts.cliConnectionName
		? await computeTunnelFingerprint(opts.cliConnectionName)
		: null;
	if (process.env.NODE_ENV === "development") {
		// Trace dev-only : facilite le debug du flow T4/1 (sans polluer la
		// prod). Format compact, aucune donnée sensible (fingerprint = hash
		// dérivé de system_identifier PG / replSet Mongo).
		process.stderr.write(
			`[sqlnest dev] cliConnectionName=${JSON.stringify(opts.cliConnectionName)} dbFingerprint=${JSON.stringify(dbFingerprint)}\n`
		);
	}
	const canonical = pairing.code.replace("-", "");
	const signature = signMessage(canonical, privateKeyHex);
	const auth = await api.authenticatePairing(
		pairing.code,
		signature,
		dbFingerprint
	);

	// ─── 6. Persist tunnel entry dans config ──────────────────────────
	// Le `deviceLabel` sert d'affichage dans la config locale + la config
	// des tunnels historiques.
	const deviceLabel =
		lastStatus.deviceName ?? opts.deviceLabelFallback ?? hostname();
	// Le `connectionName` retourné pilote `resolveLocalConnectionUrl` dans
	// le serve loop — il DOIT être le nom de la DSN LOCALE, pas le nom
	// serveur (les 2 peuvent diverger si l'user renomme sa db_connection).
	// Fallback sur deviceLabel pour les cas legacy (single-DSN sans C.13).
	const localConnectionName = opts.cliConnectionName ?? deviceLabel;
	const tunnelEntry: TunnelEntry = {
		id: auth.tunnelId,
		name: deviceLabel,
		connection_id: auth.connectionId,
		session_token: auth.token,
		expires_at: auth.expiresAt,
		// Persist le nom DSN local pour permettre l'auto-resume au
		// prochain `sqlnest connect` (voir `findResumableTunnel`).
		...(opts.cliConnectionName
			? { connection_name: opts.cliConnectionName }
			: {})
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
		connectionName: localConnectionName,
		resumed: false
	};
}

/**
 * Cherche un tunnel réutilisable dans `config.tunnels[]` — retourne
 * le plus récemment ajouté qui matche STRICTEMENT le `cliConnectionName`
 * et dont le token n'expire pas avant `TOKEN_EXPIRY_BUFFER_MS`. `null`
 * sinon.
 *
 * Matching strict par `connection_name` uniquement — pas de fallback
 * sur `name` (deviceLabel serveur). Le `name` est déclaratif côté user
 * dans /pair, il peut collision entre plusieurs tunnels et n'est pas
 * lié au fingerprint local. Réutiliser un token via un match approximatif
 * risque d'ouvrir un tunnel qui ne correspond pas à la DSN locale
 * attendue.
 *
 * Les tunnels pré-fix sans `connection_name` sont ignorés → l'user
 * doit re-pair UNE fois pour bootstrap la nouvelle entry taggée, puis
 * les relances suivantes utilisent l'auto-resume propre.
 *
 * Mode single-DSN (`cliConnectionName === null`) : matche une entry
 * sans `connection_name` (comportement legacy pré-C.13, safe car un
 * seul tunnel par install).
 */
export function findResumableTunnel(
	tunnels: readonly TunnelEntry[],
	cliConnectionName: string | null,
	nowMs: number
): TunnelEntry | null {
	const cutoff = nowMs + TOKEN_EXPIRY_BUFFER_MS;
	// Itère à l'envers — le tunnel le plus récent (append à la fin) a
	// priorité si plusieurs matchent, ce qui reflète le dernier pair
	// effectué par l'user.
	for (let i = tunnels.length - 1; i >= 0; i--) {
		const t = tunnels[i];
		if (t === undefined) continue;
		const expiresMs = Date.parse(t.expires_at);
		if (Number.isNaN(expiresMs) || expiresMs <= cutoff) continue;
		if (cliConnectionName !== null) {
			if (t.connection_name === cliConnectionName) return t;
		} else if (t.connection_name === undefined) {
			return t;
		}
	}
	return null;
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
