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

// ─── canvas_state ────────────────────────────────────────────────────────
// Snapshot serveur du canvas d'un utilisateur pour un schéma donné.
// Unique par (user_id, schema_signature) — un canvas par (user × schéma).
// La FK vers `user.id` cascade la suppression : si un compte est supprimé,
// ses canvases persistés le sont aussi.
export const canvasState = pgTable(
	"canvas_state",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		// CASCADE = choix RGPD conscient. Un DELETE user supprime définitivement
		// ses canvases persistés. Aucun soft-delete ni archivage : c'est le
		// modèle "droit à l'oubli" par défaut. En prod, toute suppression
		// massive de users doit passer par un job avec backup préalable
		// (dump table `canvas_state` filtré sur les user_id concernés).
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		// Signature du schéma introspecté — format `${engine}:${sortedCollectionNames}`.
		schemaSignature: text("schema_signature").notNull(),
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
		uniqueIndex("canvas_user_schema_unique").on(t.userId, t.schemaSignature)
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

export type CanvasState = typeof canvasState.$inferSelect;
export type NewCanvasState = typeof canvasState.$inferInsert;
