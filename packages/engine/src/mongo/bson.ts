import { isSqlDecimal } from "@sqlnest/snql";
import { Decimal128, Long, ObjectId, UUID } from "mongodb";

/**
 * Valeurs BSON : du driver vers SNQL (`normalizeBson`), de SNQL vers le driver
 * (`hydrateBson`), et les formes sous lesquelles un identifiant est stocké.
 */

/**
 * Normalise une valeur BSON en scalaire portable, pour respecter le contrat de
 * ResultSet « normalisé » : là où Postgres renvoie des scalaires, le driver Mongo
 * renvoie des objets BSON (ObjectId, Decimal128, Long, Timestamp…). On les ramène
 * à string/number/bigint (cohérent cross-moteur) ; Date reste un Date (comme pg).
 */
export function normalizeBson(value: unknown): unknown {
	if (value === null || typeof value !== "object") {
		return value;
	}
	const bsontype = (value as { readonly _bsontype?: string })._bsontype;
	if (bsontype !== undefined) {
		if (bsontype === "Long") {
			const text = String(value);
			const asNumber = Number(text);
			return Number.isSafeInteger(asNumber) ? asNumber : BigInt(text);
		}
		if (bsontype === "Int32" || bsontype === "Double") {
			return Number(String(value));
		}
		// ObjectId, Decimal128, UUID, Binary, Timestamp… → texte (comme pg pour
		// numeric/uuid/etc.). Decimal128 devient une chaîne décimale exacte.
		return String(value);
	}
	if (value instanceof Date) {
		return value;
	}
	if (Array.isArray(value)) {
		return value.map(normalizeBson);
	}
	const out: Record<string, unknown> = {};
	for (const key of Object.keys(value)) {
		out[key] = normalizeBson((value as Record<string, unknown>)[key]);
	}
	return out;
}

const OBJECT_ID_HEX = /^[0-9a-fA-F]{24}$/;

/**
 * Hydrate les valeurs produites par le codegen (pur, sans dépendance BSON) avant
 * de les passer au driver — l'inverse de {@link normalizeBson} :
 *  - marqueur SqlDecimal → **Decimal128** (décimal exact ; un `Number()` serait lossy) ;
 *  - `bigint` → **Long** (int64 ; le codegen refuse déjà les valeurs hors plage) ;
 *  - dans un FILTRE, une chaîne 24-hex comparée au champ `_id` → **ObjectId**. La
 *    lecture normalise ObjectId→chaîne ; sans cet inverse, `where _id = "…"` ne
 *    matcherait jamais, et `where _id != "…"` matcherait TOUT (→ collection vidée).
 *
 * `inId` suit la position sous une clé `_id` : hérité par les opérateurs
 * (`$eq`/`$in`/`$nin`…), réinitialisé par tout autre champ. `filter=true` = filtre
 * (expansion both-forms sur `_id` via {@link expandIdFilter}) ; `filter=false` =
 * document inséré / valeur de set / clé de join → AUCUNE coercion `_id` (fidélité
 * BSON #7 : on stocke la valeur telle quelle, le filtre both-forms la retrouve).
 */
export function hydrateBson(
	value: unknown,
	filter: boolean,
	inId = false
): unknown {
	if (isSqlDecimal(value)) {
		return Decimal128.fromString(value.raw);
	}
	if (typeof value === "bigint") {
		return Long.fromBigInt(value);
	}
	if (typeof value === "string") {
		return filter && inId && OBJECT_ID_HEX.test(value)
			? new ObjectId(value)
			: value;
	}
	if (value === null || typeof value !== "object" || value instanceof Date) {
		return value;
	}
	// Valeur déjà BSON (défaut posé par l'adapter : UUID, Decimal128…).
	if ((value as { _bsontype?: unknown })._bsontype !== undefined) return value;
	if (Array.isArray(value)) {
		return value.map((item) => hydrateBson(item, filter, inId));
	}
	const out: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(value)) {
		if (key === "_id" && filter) {
			// Filtre sur `_id` : matche ObjectId ET string (both-forms, ADR-032/
			// fidélité #7), sans deviner le type stocké. L'expansion gère la coercion.
			out[key] = expandIdFilter(child);
			continue;
		}
		const childInId = key.startsWith("$") ? inId : false;
		out[key] = hydrateBson(child, filter, childInId);
	}
	return out;
}

/**
 * Clé de comparaison d'une valeur BSON, à la façon de `$in` : le type compte
 * (ObjectId ≠ chaîne de même hex), les numériques se comparent par valeur
 * (int, long, double et decimal égaux matchent).
 */
export function bsonMatchKey(value: unknown): string {
	if (value instanceof ObjectId) return `o:${value.toHexString()}`;
	if (value instanceof Date) return `d:${value.getTime()}`;
	if (typeof value === "number" || typeof value === "bigint") {
		return `n:${Number(value)}`;
	}
	if (value instanceof Long || value instanceof Decimal128) {
		return `n:${Number(value.toString())}`;
	}
	const bsontype = (value as { _bsontype?: unknown } | null)?._bsontype;
	if (bsontype === "Binary") {
		const bin = value as { sub_type: number; toString(enc: "hex"): string };
		return `b:${bin.sub_type}:${bin.toString("hex")}`;
	}
	if (bsontype === "Int32" || bsontype === "Double") {
		return `n:${(value as { valueOf(): number }).valueOf()}`;
	}
	return `${typeof value}:${JSON.stringify(value)}`;
}

export const UUID_TEXT =
	/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Un uuid écrit en texte : sa forme binaire (sous-type 4), puis le texte, et
 * ses minuscules — la forme d'un uuid rangé en texte (ADR-036 D6).
 */
export function uuidForms(value: unknown): unknown[] | undefined {
	if (typeof value !== "string" || !UUID_TEXT.test(value)) return undefined;
	const lower = value.toLowerCase();
	return lower === value
		? [new UUID(value), value]
		: [new UUID(value), value, lower];
}

/** Un texte 24-hex : aussi un ObjectId, la forme d'une FK vers une clé ObjectId. */
export function objectIdForms(value: unknown): unknown[] | undefined {
	return typeof value === "string" && OBJECT_ID_HEX.test(value)
		? [new ObjectId(value), value]
		: undefined;
}

/** Une clé `_id` écrite en texte peut être stockée en ObjectId ou en UUID
 *  (alias `id: uuid`, ADR-036 E/1f) : les deux formes. */
export function idBothForms(value: unknown): unknown[] | undefined {
	if (typeof value === "string" && OBJECT_ID_HEX.test(value)) {
		return [new ObjectId(value), value];
	}
	return uuidForms(value);
}

/**
 * Condition de filtre où une valeur matche toutes ses formes stockées
 * (`forms`) : égalité ou `$eq` → `$in`, `$ne` → `$nin`, listes `$in` / `$nin`
 * étendues. Le reste passe par `other`.
 */
export function expandForms(
	child: unknown,
	forms: (value: unknown) => unknown[] | undefined,
	other: (value: unknown) => unknown
): unknown {
	const direct = forms(child);
	if (direct !== undefined) return { $in: direct };
	if (child === null || typeof child !== "object" || Array.isArray(child)) {
		return other(child);
	}
	const entries = Object.entries(child as Record<string, unknown>);
	const [entry] = entries;
	if (entries.length === 1 && entry !== undefined) {
		const [op, v] = entry;
		const vForms = forms(v);
		if (op === "$eq" && vForms !== undefined) return { $in: vForms };
		if (op === "$ne" && vForms !== undefined) return { $nin: vForms };
		if ((op === "$in" || op === "$nin") && Array.isArray(v)) {
			return { [op]: v.flatMap((x) => forms(x) ?? [other(x)]) };
		}
	}
	return other(child);
}

/**
 * Expansion both-forms d'un filtre sur `_id` (fidélité BSON, lean-robuste #7).
 * Une valeur 24-hex matche ObjectId OU string, un uuid texte UUID OU string,
 * via `$in`/`$nin` — robuste que le
 * `_id` soit auto-généré (ObjectId) ou custom (string), sans schema ni thread.
 * `$eq`/`$ne` réécrits en `$in`/`$nin` both-forms ; ranges (`$gt`/`$lt`…) gardent
 * la coercion ObjectId simple ; le reste retombe sur l'hydratation normale.
 */
function expandIdFilter(child: unknown): unknown {
	return expandForms(child, idBothForms, (v) => hydrateBson(v, true, true));
}
