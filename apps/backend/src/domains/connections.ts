import {
	type ResolvedEngineConfig,
	resolveMongoConfig,
	resolvePostgresConfig
} from "@sqlnest/engine";

// Connexions cibles. Défaut = `sqlnest_shop` (dataset e-commerce, `pnpm
// db:seed:shop`) ; surchargeables par variables d'env. `sqlnest_demo` (3 lignes)
// reste réservée aux tests d'intégration.
const PG_URL =
	process.env.SCHEMA_PG_URL ??
	"postgres://sqlnest:sqlnest@localhost:5433/sqlnest_shop";
const MONGO_URL =
	process.env.SCHEMA_MONGO_URL ??
	"mongodb://sqlnest:sqlnest@localhost:27017/sqlnest_shop?authSource=admin";

export type TargetEngine = "postgres" | "mongodb";

/**
 * Config de connexion résolue pour le moteur demandé. `schema` (Postgres
 * uniquement) surcharge le schéma cible par requête — vide/absent ⇒ défaut de
 * l'URL (`public`). Ignoré pour Mongo (pas de notion de schéma). La validation
 * du nom incombe à `resolvePostgresConfig` (identifiant simple).
 */
export function resolveConnection(
	engine: TargetEngine,
	schema?: string
): ResolvedEngineConfig {
	if (engine === "mongodb") {
		return resolveMongoConfig({ url: MONGO_URL });
	}
	const trimmed = schema?.trim();
	return resolvePostgresConfig(
		trimmed ? { url: PG_URL, schema: trimmed } : { url: PG_URL }
	);
}
