import { type ClientSession, type Document, UUID } from "mongodb";
import { hydrateBson } from "./bson";
import type { MongoContext } from "./context";
import { metadataCollection } from "./metadata";

/**
 * Valeurs par défaut des colonnes, gardées dans le validateur de la collection.
 */

/**
 * Pose les défauts de `_snql_defaults` (ADR-036 D4) sur chaque document qui
 * n'a pas la colonne — un `null` explicite reste `null`, comme en SQL.
 * `now` vaut la même date pour tout le lot, `uuid` un uuid par document.
 * Best-effort : `_snql_defaults` absent → documents inchangés.
 */
export async function withDefaults<T extends object>(
	cx: MongoContext,
	collection: string,
	documents: readonly T[],
	session?: ClientSession
): Promise<T[]> {
	let entries: Document[];
	try {
		entries = await cx
			.db()
			.collection("_snql_defaults")
			.find({ collection }, session !== undefined ? { session } : {})
			.toArray();
	} catch {
		return [...documents];
	}
	if (entries.length === 0) return [...documents];
	const now = new Date();
	return documents.map((doc) => {
		const out = { ...doc } as Record<string, unknown>;
		for (const entry of entries) {
			const column = entry.column as string;
			if (out[column] !== undefined) continue;
			out[column] =
				entry.fn === "now"
					? now
					: entry.fn === "uuid"
						? new UUID()
						: entry.value;
		}
		return out as T;
	});
}

/** Écrit (ou remplace) le défaut d'une colonne dans `_snql_defaults`. */
export async function storeDefault(
	cx: MongoContext,
	collection: string,
	spec: {
		readonly column: string;
		readonly value?: unknown;
		readonly fn?: string;
	}
): Promise<void> {
	const entry: Document = { collection, column: spec.column };
	if (spec.fn !== undefined) entry.fn = spec.fn;
	else entry.value = hydrateBson(spec.value ?? null, false);
	await metadataCollection(cx.db(), "_snql_defaults").replaceOne(
		{ _id: `${collection}.${spec.column}` },
		entry,
		{ upsert: true }
	);
}
