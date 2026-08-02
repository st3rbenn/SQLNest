/**
 * Setup file Vitest — chargé AVANT tout import de test.
 *
 * ─── But ──────────────────────────────────────────────────────────────
 * Isoler la base de données des tests d'intégration de la base de
 * développement. Les fichiers `.int.test.ts` font des TRUNCATE massifs
 * à chaque `beforeEach` (user, session, account, verification,
 * canvas_state) — historique interne : ça a détruit deux fois les
 * données du compte dev quand ces tests ont tourné contre `sqlnest_app`.
 *
 * ─── Ce que fait ce fichier ────────────────────────────────────────────
 * 1. Charge le `.env` racine (dotenv), même chemin que drizzle.config.ts.
 * 2. Refuse de démarrer si `DATABASE_URL_TEST` est absent — pas de
 *    silent fallback vers `DATABASE_URL` (ce serait le pire des mondes).
 * 3. Refuse de démarrer si `DATABASE_URL_TEST` ne contient pas le mot
 *    `test` — filet de sécurité contre un `.env` mal édité qui pointerait
 *    la variable test vers la DB dev par erreur.
 * 4. RÉÉCRIT `process.env.DATABASE_URL = process.env.DATABASE_URL_TEST`
 *    AVANT que quelque plugin ne lise `process.env.DATABASE_URL`
 *    (le plugin `02-db` le lit au premier `register`).
 *
 * ─── Pourquoi pas juste `DATABASE_URL` dans un .env.test ? ─────────────
 * Vitest ne charge pas `.env.test` automatiquement, et forcer les
 * développeurs à jongler avec deux fichiers pour un truc aussi critique
 * est fragile. On garde UN `.env` avec `DATABASE_URL` + `DATABASE_URL_TEST`,
 * et ce setup fait la bascule au bon moment.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";

const rootEnv = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"..",
	".env"
);
loadEnv({ path: rootEnv, quiet: true });

const testUrl = process.env.DATABASE_URL_TEST;

if (!testUrl || testUrl.length === 0) {
	throw new Error(
		`DATABASE_URL_TEST manquant dans ${rootEnv} — impossible de démarrer les tests d'intégration sans DB de test isolée. Ajoute :\n  DATABASE_URL_TEST=postgres://sqlnest_test:sqlnest_test_dev@localhost:5435/sqlnest_test\net vérifie que le container postgres-test tourne (\`pnpm db:up\`).`
	);
}

if (!/test/i.test(testUrl)) {
	throw new Error(
		`DATABASE_URL_TEST (${testUrl}) ne contient pas le mot "test" — refus de démarrer les tests. Cette garde bloque une configuration où la DB test pointerait vers la DB dev par erreur. Corrige le nom (user, dbname, ou host) dans le .env avant de relancer.`
	);
}

process.env.DATABASE_URL = testUrl;
