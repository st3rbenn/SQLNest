import type { Collection } from "../schema/schema-model";

/**
 * Table virtuelle SQLNest — l'audit trail `schema_events` visible dans TOUS
 * les canvases, indépendante de la DB user. Alimentée par
 * `canvas_checksum_event` côté backend, jamais persistée dans la DB user.
 *
 * Consommé par le node RF système (rendu visuel dans le canvas). L'exécution
 * SNQL passe par `list schema_events` (verbe introspect dédié) — pas
 * d'injection dans le SchemaModel de l'autocomplete, le lexer/parser
 * reconnaît le kind via `INTROSPECT_SUPPORT`.
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
