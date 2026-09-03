import type { Collection, Relation } from "@sqlnest/snql";

/**
 * Inférence de relations par **heuristique de nommage** — partagée
 * Mongo/MSSQL : un champ `<x>_id` pointe vers la collection `<x>` (ou ses
 * pluriels réguliers/irréguliers) si elle existe. `origin: naming-heuristic`,
 * confidence 0.6 — l'utilisateur pourra confirmer. Indispensable sur les
 * bases legacy SANS contraintes FK déclarées (le catalogue est vide, les
 * liens n'existent que par convention) : sans elle, le canvas d'une telle
 * base n'a aucun edge alors que Mongo — schema-less par nature — en infère.
 *
 * La CLÉ CIBLE varie par moteur : `_id` universel côté Mongo ; côté
 * relationnel, la PK single-column de la table cible, sinon la colonne
 * homonyme du champ source (`album.artist_id` → `artist.artist_id`).
 * `targetKeyFor` encapsule ce choix. Ne matche que si la collection ET la
 * clé existent réellement → aucun faux positif structurel.
 */

/** Suffixes après lesquels le pluriel anglais est en `-es` (address → addresses). */
const ES_ENDINGS = ["s", "x", "z", "ch", "sh"];

/**
 * Cible d'un champ `<x>_id` : la première collection existante parmi les
 * formes plausibles du pluriel/singulier de `<x>` (`category` → `categories`,
 * `address` → `addresses`).
 */
function resolveTargetCollection(
	prefix: string,
	names: ReadonlySet<string>
): string | undefined {
	const candidates = [`${prefix}s`, prefix];
	if (prefix.endsWith("y")) {
		candidates.push(`${prefix.slice(0, -1)}ies`); // category → categories
	}
	if (ES_ENDINGS.some((ending) => prefix.endsWith(ending))) {
		candidates.push(`${prefix}es`); // address → addresses, box → boxes
	}
	return candidates.find((candidate) => names.has(candidate));
}

export interface InferNamingRelationsOptions {
	/**
	 * Clé de la collection CIBLE vers laquelle la relation pointe, pour un
	 * champ source donné. `undefined` = pas de clé plausible → relation
	 * skippée. Mongo renvoie toujours `_id` ; le relationnel renvoie la PK
	 * single-column ou la colonne homonyme.
	 */
	readonly targetKeyFor: (
		target: Collection,
		sourceFieldName: string
	) => string | undefined;
	/**
	 * Paires `from.collection → to.collection` déjà couvertes par une
	 * relation DÉCLARÉE (FK catalogue) — l'heuristique ne double jamais une
	 * vérité déclarée. Clés au format `from|to`.
	 */
	readonly declaredPairs?: ReadonlySet<string>;
}

/** Clé de dédupe d'une paire de collections. */
export function relationPairKey(from: string, to: string): string {
	return `${from}|${to}`;
}

export function inferNamingRelations(
	collections: readonly Collection[],
	options: InferNamingRelationsOptions
): Relation[] {
	const byName = new Map(collections.map((c) => [c.name, c]));
	const names = new Set(byName.keys());
	const relations: Relation[] = [];

	for (const collection of collections) {
		for (const field of collection.fields) {
			if (field.name === "_id" || !field.name.endsWith("_id")) {
				continue;
			}
			const prefix = field.name.slice(0, -"_id".length);
			const targetName = resolveTargetCollection(prefix, names);
			if (targetName === undefined || targetName === collection.name) {
				continue;
			}
			if (
				options.declaredPairs?.has(
					relationPairKey(collection.name, targetName)
				) === true
			) {
				continue;
			}
			const target = byName.get(targetName);
			if (target === undefined) continue;
			const targetKey = options.targetKeyFor(target, field.name);
			if (targetKey === undefined) continue;
			relations.push({
				from: { collection: collection.name, fields: [field.name] },
				to: { collection: targetName, fields: [targetKey] },
				kind: "many-to-one",
				origin: "naming-heuristic",
				confidence: 0.6
			});
		}
	}

	return relations;
}
