/**
 * `secondaryStorage` Better Auth qui hash le KEY et chiffre le VALUE.
 *
 * Voir aussi `packages/db/src/schema.ts` (table `session_kv`).
 *
 * ─── Contrat Better Auth ──────────────────────────────────────────────────
 * BA appelle `secondaryStorage.{get,set,delete}(key, value?, ttl?)`. Le
 * `key` est en général le token de session en clair (issu du cookie côté
 * client). Il peut aussi être une clé auxiliaire (`active-sessions-<userId>`,
 * `verification:<id>`, etc.). Le `value` est un JSON stringifié.
 *
 * ─── Ce qu'on transforme ─────────────────────────────────────────────────
 *   - `key`   → SHA-256(key) — 64 chars hex. Le clearToken ne touche
 *     JAMAIS la DB. Un dump DB donne des hashes, non reversibles → un
 *     attaquant ne peut pas fabriquer un cookie qui matche (préimage-
 *     résistance de SHA-256).
 *   - `value` → AES-256-GCM(value) — chiffré au repos. Le payload contient
 *     `{session, user}` avec l'email, le nom, etc. — un dump DB ne fuit
 *     ni ces données ni la liste `active-sessions-<userId>` qui contient
 *     à son tour des tokens en clair (BA les stocke pour listSessions /
 *     deleteUserSessions).
 *
 * Le TTL Better Auth (secondes) est traduit en `expires_at` DB. La purge
 * est faite (a) lazy à la lecture (row expirée → delete + return null),
 * (b) pousser un cron dédié plus tard pour éviter l'accumulation muette.
 *
 * ─── Format ciphertext ───────────────────────────────────────────────────
 *   `<12 bytes iv>|<16 bytes tag>|<payload chiffré>` encodés en base64
 *   concaténés par `.`. On garde iv/tag distincts → rotation d'AUTH_SECRET
 *   plus tard = fenêtre de compatibilité (préfixer la version dans le
 *   ciphertext quand ça arrivera).
 *
 * ─── Dérivation de clé ───────────────────────────────────────────────────
 * `AUTH_SECRET` est déjà validé par `env.schema.ts` (minLength 32, rejet
 * placeholders). On dérive une clé AES-256 (32 bytes) via SHA-256 pour
 * garantir une taille exacte quelle que soit la longueur du secret.
 */

import {
	createCipheriv,
	createDecipheriv,
	createHash,
	randomBytes
} from "node:crypto";
import { schema as dbSchema } from "@sqlnest/db";
import { and, eq, lt } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

const IV_LEN = 12; // Standard pour GCM.
const AUTH_TAG_LEN = 16;

function deriveAesKey(secret: string): Buffer {
	return createHash("sha256").update(secret, "utf8").digest();
}

function sha256Hex(input: string): string {
	return createHash("sha256").update(input, "utf8").digest("hex");
}

function encryptGcm(plaintext: string, key: Buffer): string {
	const iv = randomBytes(IV_LEN);
	const cipher = createCipheriv("aes-256-gcm", key, iv);
	const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
	const tag = cipher.getAuthTag();
	return `${iv.toString("base64")}.${tag.toString("base64")}.${enc.toString("base64")}`;
}

function decryptGcm(payload: string, key: Buffer): string | null {
	const parts = payload.split(".");
	if (parts.length !== 3) return null;
	const [ivPart, tagPart, encPart] = parts as [string, string, string];
	try {
		const iv = Buffer.from(ivPart, "base64");
		const tag = Buffer.from(tagPart, "base64");
		const enc = Buffer.from(encPart, "base64");
		if (iv.length !== IV_LEN || tag.length !== AUTH_TAG_LEN) return null;
		const decipher = createDecipheriv("aes-256-gcm", key, iv);
		decipher.setAuthTag(tag);
		const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
		return dec.toString("utf8");
	} catch {
		// Auth tag mismatch = données trafiquées ou clé changée. On ignore.
		return null;
	}
}

export interface SecondaryStorage {
	get(key: string): Promise<string | null>;
	set(key: string, value: string, ttlSeconds?: number): Promise<void>;
	delete(key: string): Promise<void>;
}

export function createHashedSessionStorage(
	db: FastifyInstance["db"],
	authSecret: string
): SecondaryStorage {
	if (!authSecret || authSecret.length < 32) {
		throw new Error(
			"createHashedSessionStorage: AUTH_SECRET manquant ou < 32 chars — impossible de dériver la clé AES."
		);
	}
	const key = deriveAesKey(authSecret);

	return {
		async get(rawKey) {
			const hashed = sha256Hex(rawKey);
			const rows = await db
				.select()
				.from(dbSchema.sessionKv)
				.where(eq(dbSchema.sessionKv.key, hashed))
				.limit(1);
			const row = rows[0];
			if (!row) return null;
			if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) {
				// Row expirée → cleanup lazy. Le DELETE filtre ET par
				// `key` ET par `expiresAt < now` pour ÉVITER d'écraser une
				// row fraîche qu'un `.set()` concurrent aurait upserté
				// entre notre SELECT et notre DELETE (race classique
				// read-then-delete sans compare-and-swap). Sans ce filtre,
				// un refresh session (BA `updateAge`) parallèle à un
				// GET pourrait délogger l'user instantanément.
				const now = new Date();
				await db
					.delete(dbSchema.sessionKv)
					.where(
						and(
							eq(dbSchema.sessionKv.key, hashed),
							lt(dbSchema.sessionKv.expiresAt, now)
						)
					);
				return null;
			}
			const plaintext = decryptGcm(row.value, key);
			// Décryption ratée = donnée corrompue OU rotation AUTH_SECRET.
			// On log + retourne null MAIS on ne supprime PAS la row : trop
			// risqué (une rotation en cours pourrait effacer toutes les
			// sessions actives). L'expiration TTL naturelle nettoiera.
			if (plaintext === null) return null;
			return plaintext;
		},
		async set(rawKey, value, ttlSeconds) {
			const hashed = sha256Hex(rawKey);
			const encrypted = encryptGcm(value, key);
			const expiresAt =
				ttlSeconds && ttlSeconds > 0
					? new Date(Date.now() + ttlSeconds * 1000)
					: null;
			await db
				.insert(dbSchema.sessionKv)
				.values({ key: hashed, value: encrypted, expiresAt })
				.onConflictDoUpdate({
					target: dbSchema.sessionKv.key,
					set: { value: encrypted, expiresAt }
				});
		},
		async delete(rawKey) {
			const hashed = sha256Hex(rawKey);
			await db
				.delete(dbSchema.sessionKv)
				.where(eq(dbSchema.sessionKv.key, hashed));
		}
	};
}

/**
 * Cleanup des rows expirées (à appeler périodiquement via cron ou plugin
 * @fastify/schedule). Exporté pour permettre un job dédié — sinon la
 * purge lazy à la lecture suffit pour la correction, juste pas pour la
 * taille de la table qui grossit avec les sessions abandonnées.
 */
export async function purgeExpiredSessionKv(
	db: FastifyInstance["db"]
): Promise<number> {
	const now = new Date();
	const deleted = await db
		.delete(dbSchema.sessionKv)
		.where(
			and(
				// Ne purge que les rows AVEC un expiresAt défini.
				eq(dbSchema.sessionKv.expiresAt, dbSchema.sessionKv.expiresAt),
				lt(dbSchema.sessionKv.expiresAt, now)
			)
		)
		.returning();
	return deleted.length;
}
