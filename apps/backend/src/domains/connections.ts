import {
	type ResolvedEngineConfig,
	resolveMongoConfig,
	resolvePostgresConfig
} from "@sqlnest/engine";

// Connexions cibles (démo par défaut ; surchargeables par variables d'env).
const PG_URL =
	process.env.SCHEMA_PG_URL ??
	"postgres://sqlnest:sqlnest@localhost:5433/sqlnest_demo";
const MONGO_URL =
	process.env.SCHEMA_MONGO_URL ??
	"mongodb://sqlnest:sqlnest@localhost:27017/sqlnest_demo?authSource=admin";

export type TargetEngine = "postgres" | "mongodb";

/** Config de connexion résolue pour le moteur demandé. */
export function resolveConnection(engine: TargetEngine): ResolvedEngineConfig {
	return engine === "postgres"
		? resolvePostgresConfig({ url: PG_URL })
		: resolveMongoConfig({ url: MONGO_URL });
}
