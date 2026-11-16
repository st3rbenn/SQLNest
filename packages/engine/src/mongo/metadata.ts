import type { Collection, Db, Document } from "mongodb";

/**
 * Document d'une collection de métadonnées SNQL : sa clé est un nom
 * (`<collection>.<colonne>`, nom d'une clé étrangère, nom d'une collection),
 * pas un ObjectId.
 */
export type NamedDocument = Document & { _id: string };

/**
 * Collection de métadonnées SNQL (`_snql_refs`, `_snql_defaults`, `_snql_pk`),
 * typée par sa clé textuelle : sans cela le pilote suppose un ObjectId et
 * refuse un nom comme `_id`.
 */
export function metadataCollection(
	db: Db,
	name: string
): Collection<NamedDocument> {
	return db.collection<NamedDocument>(name);
}
