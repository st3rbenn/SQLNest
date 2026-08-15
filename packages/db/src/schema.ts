import { sql } from "drizzle-orm";
import {
	boolean,
	index,
	jsonb,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid
} from "drizzle-orm/pg-core";

/**
 * Schéma DB SQLNest.
 *
 * Comprend :
 *   - `canvasState` (Phase 1) : snapshot serveur du canvas d'un utilisateur.
 *   - `user`, `session`, `account`, `verification` (Phase 2) : tables auth
 *     alignées sur le schéma canonique de Better Auth (adapter Drizzle).
 *   - `apiToken`, `tunnelPairing`, `dbConnection` (Bloc CLI + tunnel WSS) :
 *     device-flow pairing du CLI, API tokens CI, et catalogue des connexions
 *     nommées par user. **Aucune** de ces tables ne stocke un DSN, un mot de
 *     passe, une URL ou tout autre secret de connexion DB — les credentials
 *     vivent uniquement dans la config du CLI local. Cette règle est ancrée
 *     par le test `db-schema-guard.test.ts` (échec CI si une colonne
 *     `password/url/dsn/secret/…` est introduite).
 *
 * NOTE : le schéma auth ci-dessous est écrit MANUELLEMENT et doit rester
 * synchronisé avec la version canonique de Better Auth. Si Better Auth
 * évolue (nouvelles colonnes, renames), régénérer ce fichier via :
 *
 *   npx @better-auth/cli generate --output packages/db/src/schema.ts
 *
 * puis re-appliquer les extensions SQLNest (canvasState + FK canvas → user).
 *
 * Convention : snake_case côté DB, camelCase côté TS (comme canvasState).
 */

// ─── user ────────────────────────────────────────────────────────────────
// Utilisateur authentifié. IDs générés côté SDK Better Auth (donc `text`,
// pas `uuid pgen`) — permet à Better Auth d'utiliser des identifiants de
// type nanoid/cuid selon sa config.
export const user = pgTable("user", {
	id: text("id").primaryKey(),
	// Unicité case-insensitive assurée en plus par un index fonctionnel
	// `CREATE UNIQUE INDEX user_email_lower_unique ON "user" (lower(email))`
	// ajouté à la main dans la migration 0002 (Drizzle ne génère pas les
	// expressions d'index côté schéma). Empêche `Alice@x.com` et `alice@x.com`
	// de coexister — protection classique contre les attaques d'énumération.
	email: text("email").notNull().unique(),
	emailVerified: boolean("email_verified").notNull().default(false),
	// notNull + default '' : le default couvre les futurs INSERT sans name,
	// et la migration 0002 backfille en amont les lignes existantes avec
	// name=NULL (UPDATE ... WHERE name IS NULL) avant le SET NOT NULL —
	// sans ce backfill, un env peuplé sous 0001 verrait la migration crasher.
	name: text("name").notNull().default(""),
	image: text("image"),
	createdAt: timestamp("created_at", { withTimezone: true })
		.notNull()
		.defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true })
		.notNull()
		.defaultNow()
});

// ─── session ─────────────────────────────────────────────────────────────
// Session opaque signée par AUTH_SECRET, stockée en cookie HTTP-only côté
// client et matérialisée ici pour permettre la révocation server-side.
export const session = pgTable(
	"session",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		token: text("token").notNull().unique(),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		ipAddress: text("ip_address"),
		userAgent: text("user_agent"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow()
	},
	(t) => [
		// Lookup fréquent : lister/révoquer les sessions d'un user.
		index("session_user_id_idx").on(t.userId),
		// Purge des sessions expirées (job cron / GC Better Auth).
		index("session_expires_at_idx").on(t.expiresAt)
	]
);

// ─── account ─────────────────────────────────────────────────────────────
// Compte OAuth ou credential (email/password) lié à un `user`.
// - `providerId` : 'google', 'github', ou 'credential' (email/password).
// - `accountId` : identifiant remote du provider (sub Google, id GitHub, ou
//   l'email pour 'credential').
// - `password` : hash argon2id géré par Better Auth (uniquement pour
//   'credential', null sinon).
// Un même utilisateur peut avoir plusieurs comptes (link OAuth + password).
export const account = pgTable(
	"account",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		providerId: text("provider_id").notNull(),
		accountId: text("account_id").notNull(),
		accessToken: text("access_token"),
		refreshToken: text("refresh_token"),
		idToken: text("id_token"),
		accessTokenExpiresAt: timestamp("access_token_expires_at", {
			withTimezone: true
		}),
		refreshTokenExpiresAt: timestamp("refresh_token_expires_at", {
			withTimezone: true
		}),
		scope: text("scope"),
		password: text("password"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow()
	},
	(t) => [
		uniqueIndex("account_provider_account_unique").on(
			t.providerId,
			t.accountId
		),
		// Lookup fréquent : lister les comptes liés d'un user (settings page,
		// écran de link provider). Sans cet index → seq scan.
		index("account_user_id_idx").on(t.userId)
	]
);

// ─── verification ────────────────────────────────────────────────────────
// Tokens éphémères pour vérification email + reset password.
// - `identifier` : l'email cible.
// - `value` : le token (hashé si config Better Auth active le hashing).
// - `expiresAt` : TTL court (typiquement 1h).
export const verification = pgTable(
	"verification",
	{
		id: text("id").primaryKey(),
		identifier: text("identifier").notNull(),
		value: text("value").notNull(),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow()
	},
	(t) => [
		// Lookup principal : retrouver un token à partir de l'email cible.
		index("verification_identifier_idx").on(t.identifier),
		// Purge des tokens expirés (TTL court, ~1h).
		index("verification_expires_at_idx").on(t.expiresAt)
	]
);

// ─── session_kv ──────────────────────────────────────────────────────────
// Stockage KV des sessions Better Auth, avec token HASHÉ (SHA-256) en clé
// et payload CHIFFRÉ (AES-256-GCM avec AUTH_SECRET) en valeur.
//
// Pourquoi : Better Auth 1.6.x stocke `session.token` en clair dans la
// table `session` et fait le lookup par égalité — un dump DB expose donc
// tous les tokens actifs, un attaquant peut forger n'importe quel cookie.
//
// Cette table sert de backend au `secondaryStorage` custom (voir
// `apps/backend/src/plugins/03-auth/hashedSessionStorage.ts`). Better Auth
// est configuré avec `session.storeSessionInDatabase: false` — il n'écrit
// PLUS dans la table `session` (qui devient inutilisée mais garde son
// schéma pour compat future / migration retour).
//
// - `key` : SHA-256(clearToken) — 64 chars hex. Non-reversible, l'attaquant
//   avec un dump DB ne peut pas reconstruire le clearToken pour forger un
//   cookie (préimage-résistance SHA-256).
// - `value` : AES-256-GCM(JSON) — le payload `{session, user}` chiffré.
//   Un dump DB ne fuite ni les user data (email, nom) ni le contenu.
// - `expires_at` : TTL fourni par Better Auth. Purge périodique
//   recommandée (query cron / trigger DB).
//
// La table `session` existante n'est PLUS écrite. Elle est conservée par
// prudence (rollback rapide en cas de bug hashing) — à drop après quelques
// releases stables.
export const sessionKv = pgTable(
	"session_kv",
	{
		key: text("key").primaryKey(),
		value: text("value").notNull(),
		// Index pour purge des rows expirées (cron / trigger). `null` =
		// pas d'expiration (rare pour Better Auth mais accepté).
		expiresAt: timestamp("expires_at", { withTimezone: true })
	},
	(t) => [index("session_kv_expires_at_idx").on(t.expiresAt)]
);

// ─── team ────────────────────────────────────────────────────────────────
// Workspace (bucket d'isolation entre users). Chaque user a AU MOINS
// une team « Personal » auto-créée à la signup (owner unique = user),
// servant de bucket par défaut pour ses `db_connection` +
// `canvas_state`. Les URLs frontend deviennent team-scoped :
// `/team/:slug/*`.
//
// V1 : 1 team = 1 owner. Pas d'invitations, pas de rôles. La table
// `team_membership` viendra plus tard (V2) — l'ownership porté par
// `owner_id` reste la seule dimension d'accès pour le middleware.
//
// `slug` : UUID court opaque (6 hex, ~1.7e7 combos). Non-devinable, pas
// de rename V1. La regex `[0-9a-f]{6}` est enforcée côté app (Zod des
// routes) — un CHECK Postgres est overkill pour V1.
//
// Un `DELETE user` cascade → toutes ses teams → toutes ses
// `db_connection` (via `team_id`) → toutes ses `tunnel_session` +
// `canvas_state` rattachés. Isolation stricte quand un compte disparaît.
export const team = pgTable(
	"team",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		slug: text("slug").notNull().unique(),
		// Pour une team personnelle (`is_personal = true`) le name reste
		// vide en DB — l'UI affiche `${user.name}'s team` (le name suit
		// alors les rename user). Pour une team custom (V2) le name est
		// stocké tel quel.
		name: text("name").notNull().default(""),
		// C.21 UX fix : marker qui distingue la team perso auto-créée
		// à la signup des futures teams collaboratives (V2). Piloté par
		// `createPersonalTeam` (true) vs `createTeam(name)` (false, V2).
		// Frontend s'en sert pour calculer le display name dynamiquement.
		isPersonal: boolean("is_personal").notNull().default(false),
		ownerId: text("owner_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow()
	},
	(t) => [
		// List des teams d'un user (sélecteur sidebar, redirect depuis `/`).
		index("team_owner_id_idx").on(t.ownerId)
	]
);

// ─── canvas_state ────────────────────────────────────────────────────────
// Snapshot serveur du canvas d'un utilisateur pour UNE db_connection donnée.
// Unique par (user_id, db_connection_id) — un canvas par connection.
//
// Historique : la clé était (user_id, schema_signature) avec signature =
// `${engine}:${sortedCollectionNames}`. Ce modèle a échoué dès qu'un user
// avait 2 connections partageant le même set de tables (ex: deux DBs Prisma
// avec `_prisma_migrations, agency, cabinet…`) → collision, écrasement
// mutuel silencieux. Le refacto vers `/canvas/$connId` a rendu le bug visible :
// chaque navigation entre canvases écrasait le précédent. Rattaché à
// `db_connection.id` = 1 canvas par connection, isolation stricte.
//
// FK cascade : DELETE user OU DELETE db_connection → canvas orphelin
// supprimé. Le user peut ainsi révoquer/re-pair une db_connection sans
// laisser de residu.
export const canvasState = pgTable(
	"canvas_state",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		connectionId: uuid("db_connection_id")
			.notNull()
			.references(() => dbConnection.id, { onDelete: "cascade" }),
		// Payload complet : positions tables, sizes, frames, hidden, drawer
		// width, etc. Sérialisé côté frontend, opaque côté backend.
		payload: jsonb("payload").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow()
	},
	(t) => [
		uniqueIndex("canvas_user_connection_unique").on(t.userId, t.connectionId)
	]
);

// ─── api_token ───────────────────────────────────────────────────────────
// API tokens persistants pour CI/scripts. Le CLI s'authentifie en mode
// non-interactif via `sqlnest connect --token sn_XXXX` — au lieu du device
// flow, il envoie le Bearer directement à `POST /tunnels/authenticate`.
//
// Storage :
//   - `hash` = SHA-256(clearToken) — 64 chars hex. On ne stocke JAMAIS le
//     clear ; le dashboard n'affiche le token qu'une fois à la génération.
//   - `prefix` = les 8 premiers chars du clear (ex `sn_1a2b`) — sert
//     uniquement à identifier visuellement le token dans la liste
//     (l'utilisateur reconnaît "c'est mon token GitHub Actions").
//   - `last_used_at` : bumpé à chaque `authenticate` réussi — surface les
//     tokens dormants dans le dashboard.
//   - `revoked_at` : soft-revoke (pour garder l'historique). Un token
//     révoqué ne peut plus s'authentifier (WHERE `revoked_at IS NULL`).
export const apiToken = pgTable(
	"api_token",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		// Nom humain fourni à la création (ex "GitHub Actions", "Local dev CI").
		// Longueur libre côté DB — bornée côté Zod dans la route.
		name: text("name").notNull(),
		// SHA-256 hex du clair. Unique — la validation d'un Bearer devient un
		// seul lookup indexé.
		hash: text("hash").notNull(),
		// Les 8 premiers chars du clair (`sn_XXXX`). Sert à l'affichage
		// dashboard uniquement — pas un secret.
		prefix: text("prefix").notNull(),
		lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		revokedAt: timestamp("revoked_at", { withTimezone: true })
	},
	(t) => [
		// Lookup principal : valider un Bearer entrant → hit indexé unique.
		uniqueIndex("api_token_hash_unique").on(t.hash),
		// Un user ne peut pas avoir 2 tokens ACTIFS du même nom (mais peut
		// réutiliser un nom après révocation). Index partiel.
		uniqueIndex("api_token_user_name_active_unique")
			.on(t.userId, t.name)
			.where(sql`${t.revokedAt} IS NULL`),
		// List des tokens d'un user (dashboard settings) — sans cet index,
		// seq scan.
		index("api_token_user_id_idx").on(t.userId)
	]
);

// ─── tunnel_pairing ──────────────────────────────────────────────────────
// Code éphémère du device flow CLI ↔ compte user (pattern GitHub/Vercel).
// Cycle de vie :
//   1. CLI POST /tunnels/pairings → INSERT row avec `code`, `cli_pubkey`
//      et `expires_at = now + 5min`. `user_id` NULL (pas encore lié).
//   2. User visite /pair, tape le code → POST /pairings/:code/approve.
//      Le backend renseigne `user_id` + `device_name` + `approved_at`.
//   3. CLI poll `/status` détecte `approved_at`, envoie POST /authenticate
//      avec `signature_of_code`. Backend valide contre `cli_pubkey` (Ed25519),
//      génère une `tunnel_session` (voir Bloc 2), marque `consumed_at`.
//
// Une fois `consumed_at` renseigné, le code est mort — pas de réutilisation.
// `expires_at` court (5 min) protège contre le brute-force du code.
//
// **`code` en PK** : c'est déjà un identifiant unique généré par le backend
// (ex `ABCD-1234` en base32 sans confusables), pas besoin d'uuid parallèle.
export const tunnelPairing = pgTable(
	"tunnel_pairing",
	{
		code: text("code").primaryKey(),
		// NULL avant approve, renseigné à l'étape 2 du device flow.
		userId: text("user_id").references(() => user.id, {
			onDelete: "cascade"
		}),
		// Clé publique Ed25519 du CLI en hex (64 chars). C'est ce qui lie le
		// code au CLI qui l'a émis : au /authenticate, la signature du code
		// doit vérifier contre cette clé. Impossible pour un attaquant qui
		// voit passer le code de s'authentifier sans la privkey correspondante.
		cliPubkeyEd25519: text("cli_pubkey_ed25519").notNull(),
		// Nom humain du device (fourni à l'approve, sinon fallback UA côté UI).
		// Persisté ici parce qu'il est copié dans `db_connection.name` au
		// consume — évite un re-prompt.
		deviceName: text("device_name"),
		// Nom de la DSN locale que le CLI veut servir CETTE session (C.13).
		// Distinct de `deviceName` (qui est le nom user-facing côté serveur)
		// — ce champ sert UNIQUEMENT à scoper le fingerprint effectif :
		// `SHA256(pubkey || "|" || cliConnectionName)`. Permet à un même
		// install CLI (une seule keypair) de servir plusieurs DBs distinctes
		// côté serveur, chacune ayant sa propre db_connection.
		// NULL = CLI legacy (pré-C.13) → fingerprint = SHA256(pubkey) seul.
		cliConnectionName: text("cli_connection_name"),
		// C.21.4 : la team dans laquelle la db_connection sera créée.
		// Renseignée au moment du /approve (l'user choisit dans quelle
		// team ce CLI est intégré). Reste nullable pour compat CLI legacy
		// / routes globales pre-C.21 — le fallback dans
		// `authenticatePairing` prend la team perso de l'user si NULL.
		teamId: uuid("team_id").references(() => team.id, {
			onDelete: "cascade"
		}),
		approvedAt: timestamp("approved_at", { withTimezone: true }),
		consumedAt: timestamp("consumed_at", { withTimezone: true }),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow()
	},
	(t) => [
		// Purge cron des pairings expirés (`DELETE WHERE expires_at < now`).
		index("tunnel_pairing_expires_at_idx").on(t.expiresAt),
		// Retrouver les pairings d'un user (dashboard "devices en attente").
		index("tunnel_pairing_user_id_idx").on(t.userId)
	]
);

// ─── db_connection ───────────────────────────────────────────────────────
// Catalogue des connexions DB nommées par un user. **Aucune** creds ici :
// la connexion vit sur la machine du CLI (env vars, `.sqlnest.local.toml`).
// Le backend garde uniquement le mapping `name → CLI` pour router les
// queries entrantes du browser vers le bon tunnel.
//
// `cli_fingerprint` = SHA-256 hex de la `cli_pubkey_ed25519` du CLI qui a
// créé la connexion. Sert à :
//   - dashboard : "cette connection est liée au CLI de la machine X"
//   - reconnect : quand un CLI revient online, on retrouve ses connections.
//
// `engine_metadata` : jsonb libre pour version PG, list of schemas, capabilities
// remontées par l'introspection. Enrichi au premier ping/introspect.
//
// **Contrainte de sécurité forte** : cette table N'AURA JAMAIS de colonne
// `password`, `url`, `dsn`, `host`, `port`, `dbname`. Test-guard :
// `db-schema-guard.test.ts`.
export const dbConnection = pgTable(
	"db_connection",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		// C.21.2 : team scope. Chaque db_connection appartient à une team ;
		// l'owner de la team en a la propriété exclusive (V1). Une même DSN
		// CLI peut être pair-ée dans 2 teams distinctes du même user → 2
		// db_connection différentes, chacune avec son canvas_state.
		//
		// FK team cascade : DELETE team → toutes ses db_connection (+ leurs
		// tunnel_session + canvas_state en chaîne).
		//
		// `user_id` reste porté pour la compat historique et l'audit ("qui
		// a pair-é ce CLI"), mais l'AUTORISATION passe par team_id → owner
		// (voir middleware `requireTeamAccess` en C.21.3).
		teamId: uuid("team_id")
			.notNull()
			.references(() => team.id, { onDelete: "cascade" }),
		// Nom court choisi par le user au moment du pairing (`prod`, `staging`,
		// `local`). Unique par team (C.21.2 : plus par user — un même user
		// peut avoir la même DSN dans 2 teams distinctes).
		name: text("name").notNull(),
		// SHA-256 hex (64 chars) de la clé pub Ed25519 du CLI. Pas la pub elle-
		// même — on garde uniquement l'empreinte pour l'audit dashboard, la
		// pub complète vit dans `tunnel_pairing` (jusqu'au consume) puis dans
		// la session tunnel active (Bloc 2).
		cliFingerprint: text("cli_fingerprint").notNull(),
		// T4/1 : fingerprint de l'INSTANCE DB (indépendant du CLI qui s'y
		// connecte). Format `<engine>:<opaque>` — ex `pg:7331234/apollon`,
		// `mongo:rs0/prod`, `pg-fallback:abc.../db` si pg_control_system
		// refusé. Permet à un user de retrouver son canvas depuis un 2e
		// device (Mac + Windows) — le backend match `(team, db_fingerprint)`
		// avant de retomber sur `(team, cli_fingerprint)`. Nullable pour
		// rétro-compat : les vieilles db_connection sont backfillées au
		// premier connect qui l'envoie.
		dbFingerprint: text("db_fingerprint"),
		// Ex "postgres". Enum côté app, texte libre côté DB pour permettre
		// l'ajout de Mongo (v1.1) sans migration.
		engine: text("engine").notNull(),
		// Version PG, list of schemas, capabilities. Enrichi au ping/introspect.
		engineMetadata: jsonb("engine_metadata").notNull().default({}),
		// Bump à chaque nouvelle session tunnel (le CLI se reconnecte).
		activeSince: timestamp("active_since", { withTimezone: true })
			.notNull()
			.defaultNow(),
		// Bump à chaque frame reçue du CLI. Indicateur "CLI online" côté UI.
		lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
		// Snapshot précalculé du dernier rendu de preview (C.15). Structure :
		// `{ nodes: [{id,x,y,w,h}], edges: [{source,target}], frames:
		// [{key,label,hue,x,y,w,h}] }`. Alimenté par le frontend au save
		// du canvas. Sert de fallback rendu pour `MiniSchemaPreview` quand
		// le CLI est hors ligne — on re-render côté client (theme-aware)
		// au lieu d'afficher "CLI hors ligne" vide. Aucune donnée métier
		// nouvelle vs `canvas_state.payload` (les noms de tables y sont
		// déjà via `positions`).
		lastPreviewSnapshot: jsonb("last_preview_snapshot"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow()
	},
	(t) => [
		// C.21.2 — Indexes team-scoped (les user-scoped historiques ont
		// été droppés en 0013, redondants en V1 et bloquants en V2 où
		// un user peut avoir plusieurs teams).
		//
		// Une team ne peut pas avoir 2 connexions nommées "prod".
		uniqueIndex("db_connection_team_name_unique").on(t.teamId, t.name),
		// Pairing idempotent scopé team (C.21.2) : un même install CLI
		// (fingerprint) peut être pair-é dans 2 teams distinctes → 2
		// db_connection. Dans la même team, second pairing = UPDATE.
		uniqueIndex("db_connection_team_fingerprint_unique").on(
			t.teamId,
			t.cliFingerprint
		),
		// List des db_connection d'une team (gallery, dashboard).
		index("db_connection_team_id_idx").on(t.teamId),
		// Retrouver toutes les connexions liées à un CLI (reconnect, audit).
		index("db_connection_fingerprint_idx").on(t.cliFingerprint),
		// T4/1 : lookup rapide au pairing par instance DB (team + db_fingerprint).
		// Non-unique volontairement : la même DB depuis 2 CLIs distincts crée
		// 2 rows (chaque CLI a son cli_fingerprint). V2 : proposer merge UX.
		index("db_connection_team_db_fingerprint_idx").on(
			t.teamId,
			t.dbFingerprint
		),
		// List du user (audit historique : "quels CLIs ce user a-t-il
		// pair-é dans toutes ses teams ?"). Non-unique — un même user
		// peut avoir N db_connection réparties sur ses teams.
		index("db_connection_user_id_idx").on(t.userId)
	]
);

// ─── tunnel_session ──────────────────────────────────────────────────────
// Session éphémère du tunnel WS. Un `db_connection` est le device durable
// (persiste tant que l'user ne le révoque pas) ; une `tunnel_session` est
// le token opaque que le CLI présente à `WSS /tunnels/:tunnel_id` (et aux
// futures introspections /queries). Analogue de `api_token` mais scopé
// à une connection (pas à un user directement).
//
// Storage :
//   - `hash` = SHA-256(clearToken) — 64 chars hex. Le clair (`tn_<32 hex>`)
//     n'est jamais persisté. Un dump DB expose au max des hashes SHA-256.
//   - `expires_at` : TTL long par défaut (30j côté domain) — le CLI est
//     un usage semi-permanent, contrairement à une session browser.
//   - `revoked_at` : soft-revoke pour audit, filtered via WHERE
//     `revoked_at IS NULL AND expires_at > now()`.
//   - `last_used_at` : bumpé à chaque frame WS validée — surface les
//     sessions dormantes dans le dashboard.
//
// La FK vers `db_connection` cascade : si un user supprime une connexion
// (dashboard), toutes ses sessions ouvertes deviennent inutilisables.
export const tunnelSession = pgTable(
	"tunnel_session",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		connectionId: uuid("connection_id")
			.notNull()
			.references(() => dbConnection.id, { onDelete: "cascade" }),
		// SHA-256 hex du clair. Unique — la validation d'un token WS = 1 lookup.
		hash: text("hash").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		revokedAt: timestamp("revoked_at", { withTimezone: true }),
		lastUsedAt: timestamp("last_used_at", { withTimezone: true })
	},
	(t) => [
		// Lookup principal : valider le token présenté par le CLI.
		uniqueIndex("tunnel_session_hash_unique").on(t.hash),
		// List des sessions d'une connexion (dashboard, révocation en masse).
		index("tunnel_session_connection_id_idx").on(t.connectionId),
		// Purge cron des sessions expirées.
		index("tunnel_session_expires_at_idx").on(t.expiresAt)
	]
);

// ─── Types inférés ───────────────────────────────────────────────────────
export type User = typeof user.$inferSelect;
export type NewUser = typeof user.$inferInsert;

export type Session = typeof session.$inferSelect;
export type NewSession = typeof session.$inferInsert;

export type Account = typeof account.$inferSelect;
export type NewAccount = typeof account.$inferInsert;

export type Verification = typeof verification.$inferSelect;
export type NewVerification = typeof verification.$inferInsert;

export type Team = typeof team.$inferSelect;
export type NewTeam = typeof team.$inferInsert;

export type CanvasState = typeof canvasState.$inferSelect;
export type NewCanvasState = typeof canvasState.$inferInsert;

export type ApiToken = typeof apiToken.$inferSelect;
export type NewApiToken = typeof apiToken.$inferInsert;

export type TunnelPairing = typeof tunnelPairing.$inferSelect;
export type NewTunnelPairing = typeof tunnelPairing.$inferInsert;

export type DbConnection = typeof dbConnection.$inferSelect;
export type NewDbConnection = typeof dbConnection.$inferInsert;

export type TunnelSession = typeof tunnelSession.$inferSelect;
export type NewTunnelSession = typeof tunnelSession.$inferInsert;
