import type { Collection, SchemaModel } from "../schema/schema-model";

/**
 * Table virtuelle SQLNest — l'audit trail `schema_events` visible dans TOUS
 * les canvases, indépendante de la DB user. Alimentée par
 * `canvas_checksum_event` côté backend, jamais persistée dans la DB user.
 *
 * Nom réservé au namespace SQLNest — s'il colle un jour avec une vraie table
 * DB user, le rendu du canvas préfère la version système (la vraie table est
 * accessible via l'introspection normale).
 */
export const SCHEMA_EVENTS_NAME = "schema_events";

export const SCHEMA_EVENTS_COLLECTION: Collection = {
	name: SCHEMA_EVENTS_NAME,
	source: "declared",
	primaryKey: ["id"],
	fields: [
		{ name: "id", type: "string", nullable: false, source: "declared" },
		{ name: "seen_at", type: "date", nullable: false, source: "declared" },
		{ name: "checksum", type: "string", nullable: false, source: "declared" },
		{
			name: "db_connection_id",
			type: "string",
			nullable: true,
			source: "declared"
		}
	]
};

/**
 * Injecte `schema_events` dans un `SchemaModel` — utilisé côté canvas pour
 * exposer la table système à l'autocomplete SNQL sans polluer les payloads
 * backend. Si une collection portant ce nom existe déjà (collision avec une
 * vraie table DB user), on ne remplace pas — la vraie table gagne, à charge
 * du canvas de signaler la collision.
 */
export function injectSchemaEventsCollection(schema: SchemaModel): SchemaModel {
	if (schema.collections.some((c) => c.name === SCHEMA_EVENTS_NAME)) {
		return schema;
	}
	return {
		...schema,
		collections: [...schema.collections, SCHEMA_EVENTS_COLLECTION]
	};
}
