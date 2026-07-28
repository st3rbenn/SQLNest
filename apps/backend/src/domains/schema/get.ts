import {
	connect,
	resolveMongoConfig,
	resolvePostgresConfig,
	type SchemaModel
} from "@sqlnest/engine";
import type { GetSchemaQuery } from "./get.schema";

// Connexions cibles (démo par défaut ; surchargeables par variables d'env).
const PG_URL =
	process.env.SCHEMA_PG_URL ??
	"postgres://sqlnest:sqlnest@localhost:5433/sqlnest_demo";
const MONGO_URL =
	process.env.SCHEMA_MONGO_URL ??
	"mongodb://sqlnest:sqlnest@localhost:27017/sqlnest_demo?authSource=admin";

/**
 * Connecte le moteur demandé, introspecte son schéma, ferme la connexion.
 * Connexion par requête (simple) — un cache viendra si besoin de performance.
 */
export async function getSchema(
	engine: GetSchemaQuery["engine"]
): Promise<SchemaModel> {
	const config =
		engine === "postgres"
			? resolvePostgresConfig({ url: PG_URL })
			: resolveMongoConfig({ url: MONGO_URL });

	const connection = await connect(config);
	try {
		return await connection.introspect();
	} finally {
		await connection.close();
	}
}
