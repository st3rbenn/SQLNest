import { connect, type SchemaModel } from "@sqlnest/engine";
import { resolveConnection } from "../connections";
import type { GetSchemaQuery } from "./get.schema";

/**
 * Connecte le moteur demandé, introspecte son schéma, ferme la connexion.
 * Connexion par requête (simple) — un cache viendra si besoin de performance.
 */
export async function getSchema(
	engine: GetSchemaQuery["engine"]
): Promise<SchemaModel> {
	const connection = await connect(resolveConnection(engine));
	try {
		return await connection.introspect();
	} finally {
		await connection.close();
	}
}
