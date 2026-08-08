/**
 * Config CLI — lecture / écriture de `~/.sqlnest/config.toml`.
 *
 * ─── Format ────────────────────────────────────────────────────────────
 * ```toml
 * version = 1
 * salt = "16 bytes hex"     # sert à dériver la clé AES (voir `crypto.ts`)
 *
 * [keypair]
 * public = "64 hex chars"   # Ed25519 pubkey — envoyée au backend au /pairings
 * encrypted_private = "hex" # AES-256-GCM de la privkey (iv + ct + tag)
 *
 * [[tunnels]]
 * id = "uuid"               # tunnel_session.id (côté backend)
 * name = "prod"             # db_connection.name
 * connection_id = "uuid"    # db_connection.id
 * session_token = "tn_..."  # clair — protégé par les perms 0600 du fichier
 * expires_at = "2026-09-06T…Z"
 * last_used = "2026-08-06T…Z"  # optionnel
 * ```
 *
 * ─── Sécurité ──────────────────────────────────────────────────────────
 * Le fichier DOIT avoir des permissions ≤ 0600. Le chargement refuse
 * plus permissif (ex. 0644) — historique classique de fuite de secrets
 * via `chmod 644 .env` ou backup partagé.
 *
 * On stocke le `session_token` en clair — cohérent avec les patterns
 * établis (`~/.ssh/id_ed25519`, `~/.aws/credentials`, `~/.docker/config.json`).
 * En v2 : intégration keychain OS.
 */

import {
	existsSync,
	mkdirSync,
	readFileSync,
	statSync,
	writeFileSync
} from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";

/** Version du format — bump si la struct change et nécessite migration. */
export const CONFIG_VERSION = 1 as const;

/** Perms max autorisées (octal). Fichier plus permissif → refus. */
export const MAX_CONFIG_PERMS = 0o600;

/** Perms du dossier `~/.sqlnest` — le user est le seul à voir dedans. */
export const CONFIG_DIR_PERMS = 0o700;

export interface TunnelEntry {
	readonly id: string;
	readonly name: string;
	readonly connection_id: string;
	readonly session_token: string;
	readonly expires_at: string;
	readonly last_used?: string;
	/** Nom de la DSN LOCALE (`cliConnectionName`) que ce tunnel sert.
	 *  Persisté pour permettre à `connect()` de retrouver un tunnel
	 *  réutilisable et bypass le device flow quand le token est encore
	 *  valide. `undefined` sur les vieilles entries pré-auto-resume —
	 *  celles-là ne matchent jamais un `cliConnectionName` explicite,
	 *  donc l'user re-pair une fois puis a la persistance. */
	readonly connection_name?: string;
}

export interface SqlnestConfig {
	readonly version: typeof CONFIG_VERSION;
	readonly salt: string;
	readonly keypair: {
		readonly public: string;
		readonly encrypted_private: string;
	};
	readonly tunnels: readonly TunnelEntry[];
}

/** Chemin du dossier config — `~/.sqlnest` par défaut, override par
 * `SQLNEST_CONFIG_DIR` (utile pour les tests). */
export function getConfigDir(): string {
	return process.env.SQLNEST_CONFIG_DIR ?? join(homedir(), ".sqlnest");
}

/** Chemin complet du fichier `config.toml`. */
export function getConfigPath(): string {
	return join(getConfigDir(), "config.toml");
}

/**
 * Vérifie les permissions du fichier — throws si trop permissives.
 *
 * ─── Windows ──────────────────────────────────────────────────────────
 * `fs.stat().mode` ne reflète pas les ACL Windows de façon exploitable ;
 * la vérif est skippée sur `win32`. Sur Windows, l'attente est que le
 * user protège son profile utilisateur (ACL par défaut ~ user-only).
 */
export function assertConfigPerms(path: string): void {
	if (platform() === "win32") return;
	const stat = statSync(path);
	const perms = stat.mode & 0o777;
	if (perms > MAX_CONFIG_PERMS) {
		throw new Error(
			`~/.sqlnest/config.toml permissions ${perms.toString(8).padStart(4, "0")} > ${MAX_CONFIG_PERMS.toString(8).padStart(4, "0")}.\n` +
				`Fix : chmod 600 ${path}\n` +
				`Le CLI refuse de démarrer avec un fichier de config lisible par d'autres users (secrets).`
		);
	}
}

/**
 * Crée `~/.sqlnest` avec perms 0700 s'il n'existe pas. Idempotent.
 */
export function ensureConfigDir(): void {
	const dir = getConfigDir();
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true, mode: CONFIG_DIR_PERMS });
	}
}

/**
 * Charge la config depuis le fichier.
 *
 * Retourne :
 *   - `null` si le fichier n'existe pas (nouveau setup — le caller doit
 *     appeler `saveConfig` avec une struct fraîche).
 *   - `SqlnestConfig` valide sinon.
 *
 * Throws si :
 *   - permissions > 0600 (defense-in-depth secrets),
 *   - TOML malformé,
 *   - version inconnue (migration nécessaire — MVP : refuse net).
 */
export function loadConfig(): SqlnestConfig | null {
	const path = getConfigPath();
	if (!existsSync(path)) return null;

	assertConfigPerms(path);

	const raw = readFileSync(path, "utf8");
	const parsed = parseToml(raw) as unknown;
	return validateConfig(parsed);
}

/**
 * Sérialise + write avec perms 0600. Idempotent (overwrite).
 *
 * Le dossier est créé si absent (`ensureConfigDir`). Le fichier est
 * écrit avec `mode: 0600` — le CLI vérifie ensuite pour tolérer les
 * umask exotiques.
 */
export function saveConfig(config: SqlnestConfig): void {
	ensureConfigDir();
	const path = getConfigPath();
	// smol-toml serialize accepte des objets simples. On passe un shallow
	// clone pour éviter que Zod-style readonly modifiers pertube le parser.
	const serialized = stringifyToml({
		version: config.version,
		salt: config.salt,
		keypair: {
			public: config.keypair.public,
			encrypted_private: config.keypair.encrypted_private
		},
		tunnels: config.tunnels.map((t) => {
			const base: Record<string, unknown> = {
				id: t.id,
				name: t.name,
				connection_id: t.connection_id,
				session_token: t.session_token,
				expires_at: t.expires_at
			};
			if (t.last_used) base.last_used = t.last_used;
			if (t.connection_name) base.connection_name = t.connection_name;
			return base;
		})
	});
	writeFileSync(path, serialized, { mode: MAX_CONFIG_PERMS });
	// Re-check post-write : les umask non-standard peuvent altérer les
	// perms effectives (bien que `mode` soit pass à `writeFileSync`).
	assertConfigPerms(path);
}

/** Regex utilitaires — hoistées top-level (règle Biome). */
const HEX_SALT_RE = /^[0-9a-f]{32}$/;
const HEX_PUBKEY_RE = /^[0-9a-f]{64}$/;
const HEX_ENCRYPTED_PRIVKEY_RE = /^[0-9a-f]+$/;

/**
 * Valide qu'un objet parsé matche la struct `SqlnestConfig` attendue.
 * Retourne l'objet typé si OK, throw sinon.
 *
 * On fait la validation à la main (pas de Zod côté CLI) pour éviter une
 * dépendance supplémentaire. Le format est stable ; en cas d'évolution,
 * bump `version` et gérer la migration.
 */
function validateConfig(raw: unknown): SqlnestConfig {
	if (raw == null || typeof raw !== "object") {
		throw new Error("config.toml: format invalide (pas un objet TOML)");
	}
	const obj = raw as Record<string, unknown>;

	if (obj.version !== CONFIG_VERSION) {
		throw new Error(
			`config.toml: version ${String(obj.version)} inconnue (attendu ${CONFIG_VERSION}). Migration nécessaire ou fichier corrompu.`
		);
	}

	if (typeof obj.salt !== "string" || !HEX_SALT_RE.test(obj.salt)) {
		throw new Error("config.toml: `salt` doit être 32 chars hex (16 bytes).");
	}

	if (obj.keypair == null || typeof obj.keypair !== "object") {
		throw new Error("config.toml: section `[keypair]` manquante.");
	}
	const kp = obj.keypair as Record<string, unknown>;
	if (typeof kp.public !== "string" || !HEX_PUBKEY_RE.test(kp.public)) {
		throw new Error(
			"config.toml: `keypair.public` doit être 64 chars hex (Ed25519 pubkey)."
		);
	}
	if (
		typeof kp.encrypted_private !== "string" ||
		!HEX_ENCRYPTED_PRIVKEY_RE.test(kp.encrypted_private)
	) {
		throw new Error(
			"config.toml: `keypair.encrypted_private` doit être un hex non vide."
		);
	}

	const tunnelsRaw = obj.tunnels;
	const tunnels: TunnelEntry[] = [];
	if (tunnelsRaw !== undefined) {
		if (!Array.isArray(tunnelsRaw)) {
			throw new Error("config.toml: `tunnels` doit être un tableau.");
		}
		for (const [i, t] of tunnelsRaw.entries()) {
			tunnels.push(validateTunnelEntry(t, i));
		}
	}

	return {
		version: CONFIG_VERSION,
		salt: obj.salt,
		keypair: {
			public: kp.public,
			encrypted_private: kp.encrypted_private
		},
		tunnels
	};
}

function validateTunnelEntry(raw: unknown, index: number): TunnelEntry {
	if (raw == null || typeof raw !== "object") {
		throw new Error(`config.toml: tunnels[${index}] doit être un objet.`);
	}
	const t = raw as Record<string, unknown>;
	const required = [
		"id",
		"name",
		"connection_id",
		"session_token",
		"expires_at"
	] as const;
	for (const key of required) {
		if (typeof t[key] !== "string" || (t[key] as string).length === 0) {
			throw new Error(
				`config.toml: tunnels[${index}].${key} manquant ou vide.`
			);
		}
	}
	const entry: TunnelEntry = {
		id: t.id as string,
		name: t.name as string,
		connection_id: t.connection_id as string,
		session_token: t.session_token as string,
		expires_at: t.expires_at as string,
		...(typeof t.last_used === "string" ? { last_used: t.last_used } : {}),
		...(typeof t.connection_name === "string"
			? { connection_name: t.connection_name }
			: {})
	};
	return entry;
}

/**
 * Chemin racine du dossier (utile pour les tests qui setup un dir custom
 * via `SQLNEST_CONFIG_DIR`).
 */
export function getConfigParent(): string {
	return dirname(getConfigPath());
}
