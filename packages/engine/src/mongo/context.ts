import type { Db, MongoClient } from "mongodb";

/**
 * Types partagés par les opérations de l'adaptateur MongoDB.
 */

/** Ce qu'une opération reçoit de la connexion ouverte. */
export interface MongoContext {
	/** Base ouverte ; lève si la connexion a été fermée. */
	db(): Db;
	/** Client ouvert ; lève si la connexion a été fermée. */
	client(): MongoClient;
	/** Documents échantillonnés par collection à l'introspection. */
	readonly sampleSize: number;
}

export type MongoWrite = import("@sqlnest/snql").MongoWriteQuery;
