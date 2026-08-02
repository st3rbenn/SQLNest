import cookie from "@fastify/cookie";
import { sql } from "drizzle-orm";
import Fastify, { type FastifyInstance } from "fastify";
import {
	serializerCompiler,
	validatorCompiler
} from "fastify-type-provider-zod";
import dbPlugin from "../../plugins/02-db.plugin";
import authPlugin from "../../plugins/03-auth.plugin";
import sessionPlugin from "../../plugins/04-session.plugin";

/**
 * Options d'instanciation d'une app de test.
 *
 * - `withAuth`: enregistre la stack Better Auth complète
 *   (@fastify/cookie + `02-db` + `03-auth` + `04-session`).
 *   Nécessite `process.env.DATABASE_URL` et `process.env.AUTH_SECRET`
 *   valides — voir `README` du repo pour la config `.env` locale.
 */
export interface CreateTestAppOptions {
	readonly withAuth?: boolean;
}

/**
 * Factory Fastify pour les tests.
 *
 * Retourne un `FastifyInstance` synchronement — les enregistrements de
 * plugins sont mis en file d'attente (`fastify.register(...)`) et
 * réellement appliqués lors du premier `await app.ready()` ou du premier
 * `await app.inject(...)`. Ça évite de changer la signature synchrone
 * historique tout en permettant l'option `withAuth`.
 *
 * ─── logger désactivé en test ─────────────────────────────────────────
 * Le logger Pino est bruyant dans la sortie vitest — on le mute par
 * défaut. Pour debug, passer `logger: true` en tête de fichier de test.
 *
 * ─── withAuth ─────────────────────────────────────────────────────────
 * Enregistre (dans l'ordre) :
 *   1. `@fastify/cookie` — parser cookie AVANT le catch-all Better Auth,
 *      cohérent avec `src/index.ts`.
 *   2. `02-db.plugin` (nom fp `02-db`) — décore `fastify.db`.
 *   3. `03-auth.plugin` (nom fp `03-auth`, dependencies ["02-db"]) —
 *      décore `fastify.auth` et monte le catch-all `/api/auth/*`.
 *   4. `04-session.plugin` (nom fp `04-session`, dependencies ["03-auth"])
 *      — ajoute le hook global `preHandler` qui populate `request.user`.
 *
 * Les plugins lisent `process.env.{DATABASE_URL,AUTH_SECRET,...}` au
 * moment du register — l'appelant DOIT avoir peuplé ces variables avant
 * `await app.ready()` (typiquement dans un `beforeAll`).
 */
export function createTestApp(
	options: CreateTestAppOptions = {}
): FastifyInstance {
	const server = Fastify({
		logger: false
	});
	void server.setValidatorCompiler(validatorCompiler);
	void server.setSerializerCompiler(serializerCompiler);

	if (options.withAuth) {
		// Cookie parser d'abord — mêmes raisons que dans src/index.ts.
		void server.register(cookie);
		void server.register(dbPlugin);
		void server.register(authPlugin);
		void server.register(sessionPlugin);
	}

	return server;
}

/**
 * TRUNCATE des 4 tables Better Auth (user, session, account, verification).
 *
 * ─── Usage ────────────────────────────────────────────────────────────
 *   beforeEach(async () => { await truncateAuthTables(app); });
 *
 * ─── Détails ──────────────────────────────────────────────────────────
 * - `TRUNCATE ... RESTART IDENTITY CASCADE` :
 *   - `CASCADE` : les FK `session.user_id` / `account.user_id` /
 *     `canvas_state.user_id` sont vidées automatiquement — évite un
 *     ordre d'appel fragile.
 *   - `RESTART IDENTITY` : reset les séquences si un jour on ajoute un
 *     serial (pas le cas actuel — IDs texte —, mais idiomatique).
 * - Nécessite que `withAuth: true` ait été passé à `createTestApp` (le
 *   plugin `02-db` décore `fastify.db`). Un `throw` explicite si absent
 *   pour éviter un « undefined.execute » cryptique.
 *
 * Ne truncate PAS `canvas_state` séparément : le CASCADE via
 * `session.user_id` / `account.user_id` / `canvas_state.user_id` vide
 * déjà les rows dépendantes lorsque `user` est vidé.
 */
/** Garde runtime commune : refuse tout TRUNCATE hors d'une DB _test.
 * Historique : deux fois où les tests int ont wipé la DB dev — plus jamais. */
function assertTestDatabase(): void {
	const dbUrl = process.env.DATABASE_URL;
	if (!dbUrl || !/test/i.test(dbUrl)) {
		throw new Error(
			`Refuse d'exécuter TRUNCATE contre une DB dont l'URL ne contient pas "test" (DATABASE_URL="${dbUrl ?? "<undefined>"}"). Configure DATABASE_URL_TEST dans .env et charge le setup file vitest (apps/backend/src/test-setup.ts).`
		);
	}
}

export async function truncateAuthTables(app: FastifyInstance): Promise<void> {
	if (app.db == null) {
		throw new Error(
			"truncateAuthTables: fastify.db introuvable — appelle createTestApp({ withAuth: true }) et await app.ready() d'abord."
		);
	}
	assertTestDatabase();
	await app.db.execute(
		sql`TRUNCATE TABLE "session_kv", "session", "account", "verification", "user" RESTART IDENTITY CASCADE`
	);
}

/** TRUNCATE canvas_state + auth tables. À utiliser dans les tests
 * `canvas-state.int.test.ts` qui ont besoin d'un `canvas_state` vide en
 * plus des tables auth. Le CASCADE via `user_id` aurait suffi, mais
 * l'ordre explicite documente l'intent. */
export async function truncateCanvasAndAuth(
	app: FastifyInstance
): Promise<void> {
	if (app.db == null) {
		throw new Error(
			"truncateCanvasAndAuth: fastify.db introuvable — appelle createTestApp({ withAuth: true }) et await app.ready() d'abord."
		);
	}
	assertTestDatabase();
	await app.db.execute(
		sql`TRUNCATE TABLE "canvas_state", "session_kv", "session", "account", "verification", "user" RESTART IDENTITY CASCADE`
	);
}
