import type { Connection, ResolvedEngineConfig } from "./adapter";
import { requireAdapter } from "./registry";

/**
 * `@sqlnest/engine` — couche connexion (couche 1 du Reader).
 *
 * Le contrat {@link EngineAdapter} branche un moteur sur SNQL sans toucher au
 * langage : connexion (Slice 5), puis introspection → SchemaModel (Slice 6) et
 * exécution → ResultSet (Slice 7). Voir le vault : `07 - Reader/The Cross-DB Reader`.
 */

/**
 * Résout l'adapter d'après `config.engine` et ouvre une connexion vérifiée.
 * Raccourci sur {@link requireAdapter} + `adapter.connect`.
 */
export function connect(config: ResolvedEngineConfig): Promise<Connection> {
	return requireAdapter(config.engine).connect(config);
}

export type {
	Collection,
	Field,
	FieldRef,
	Relation,
	RelationKind,
	RelationOrigin,
	ResultColumn,
	ResultSet,
	SchemaModel,
	SchemaSource,
	SnqlType
} from "@sqlnest/snql";
export type {
	Connection,
	EngineAdapter,
	PingResult,
	ResolvedEngineConfig
} from "./adapter";
export type {
	PostgresConfigInput,
	PostgresConnectionConfig,
	PostgresFieldsInput,
	PostgresUrlInput
} from "./config";
export { describePostgresConfig, resolvePostgresConfig } from "./config";
export {
	ConnectionClosedError,
	EngineConfigError,
	EngineConnectionError,
	EngineError,
	type EngineErrorCode,
	EngineExecutionError,
	EngineIntrospectionError,
	type PgErrorInfo,
	UnknownEngineError
} from "./errors";
export { mongoAdapter } from "./mongo/adapter";
export type { MongoConfigInput, MongoConnectionConfig } from "./mongo/config";
export { describeMongoConfig, resolveMongoConfig } from "./mongo/config";
export {
	inferCollection,
	inferRelations,
	introspectMongo,
	snqlTypeOf
} from "./mongo/introspect";
export { postgresAdapter } from "./postgres/adapter";
export {
	buildSchemaModel,
	introspectPostgres,
	mapPgType
} from "./postgres/introspect";
export { getAdapter, registeredEngines, requireAdapter } from "./registry";
export { runQuery } from "./run";
