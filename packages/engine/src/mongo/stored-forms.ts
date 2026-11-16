import { isSqlDecimal } from "@sqlnest/snql";
import { Decimal128, type Document } from "mongodb";
import { expandForms, objectIdForms, uuidForms } from "./bson";

/**
 * Formes stockées : une même valeur peut dormir en base sous plusieurs types
 * (uuid binaire ou texte, décimal exact ou texte). Un filtre les vise toutes.
 */

/**
 * Formes d'un littéral décimal de filtre : double, puis Decimal128 quand il
 * le représente (34 chiffres significatifs au plus).
 */
function decimalForms(value: unknown): unknown[] | undefined {
	if (!isSqlDecimal(value)) return undefined;
	const double = Number(value.raw);
	try {
		return [double, Decimal128.fromString(value.raw)];
	} catch {
		return [double];
	}
}

function storedForms(value: unknown): unknown[] | undefined {
	return uuidForms(value) ?? objectIdForms(value) ?? decimalForms(value);
}

/** `value` dont chaque littéral décimal prend sa forme Decimal128 ou double. */
function decimalAs(value: unknown, decimal: boolean): unknown {
	const forms = decimalForms(value);
	if (forms !== undefined) return decimal ? (forms[1] ?? forms[0]) : forms[0];
	return Array.isArray(value) ? value.map((v) => decimalAs(v, decimal)) : value;
}

/**
 * Condition de champ où reste un littéral décimal (une borne) : un `$or` qui
 * compare en Decimal128 les valeurs stockées en decimal, en double les
 * autres. Mongo compare un double et un Decimal128 exactement : le double
 * 0.1 n'est pas le Decimal128 0.1.
 */
function decimalBranches(field: string, cond: Document): Document | undefined {
	const ops = Object.entries(cond);
	const pending = ops.some(
		([, v]) => isSqlDecimal(v) || (Array.isArray(v) && v.some(isSqlDecimal))
	);
	if (!pending) return undefined;
	const branch = (decimal: boolean): Document => ({
		[field]: {
			...(decimal ? { $type: "decimal" } : { $not: { $type: "decimal" } }),
			...Object.fromEntries(ops.map(([op, v]) => [op, decimalAs(v, decimal)]))
		}
	});
	return { $or: [branch(true), branch(false)] };
}

export function isOperators(value: unknown): value is Document {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}
	const keys = Object.keys(value);
	return keys.length > 0 && keys.every((k) => k.startsWith("$"));
}

/**
 * Filtre où chaque littéral matche les formes sous lesquelles sa valeur peut
 * être stockée : un uuid texte aussi sa forme binaire (une colonne uuid est en
 * binData, ADR-029 D15), un décimal le double et le Decimal128 (D17). Même
 * expansion que `_id`, qui garde la sienne ({@link expandIdFilter}). Ne
 * descend que dans les conditions de champ et `$and` / `$or` / `$nor` : sous
 * `$expr`, les clés ne sont pas des champs.
 */
export function withStoredForms(query: Document): Document {
	const out: Document = {};
	const branches: Document[] = [];
	for (const [key, value] of Object.entries(query)) {
		if (key === "$and" || key === "$or" || key === "$nor") {
			out[key] = Array.isArray(value)
				? value.map((q) => withStoredForms(q as Document))
				: value;
		} else if (key.startsWith("$") || key === "_id") {
			out[key] = value;
		} else {
			const cond = expandForms(value, storedForms, (v) => v);
			const split = isOperators(cond) ? decimalBranches(key, cond) : undefined;
			if (split === undefined) out[key] = cond;
			else branches.push(split);
		}
	}
	const [only] = branches;
	if (only === undefined) return out;
	if (branches.length === 1 && out.$or === undefined) {
		return { ...out, ...only };
	}
	const and = Array.isArray(out.$and) ? (out.$and as Document[]) : [];
	return { ...out, $and: [...and, ...branches] };
}

/** {@link withStoredForms} sur les `$match` d'un pipeline, sous-pipelines de `$lookup` compris. */
export function pipelineWithStoredForms(
	stages: readonly Document[]
): Document[] {
	return stages.map((stage) => {
		if (stage.$match !== undefined) {
			return { ...stage, $match: withStoredForms(stage.$match as Document) };
		}
		const lookup = stage.$lookup as Document | undefined;
		return Array.isArray(lookup?.pipeline)
			? {
					...stage,
					$lookup: {
						...lookup,
						pipeline: pipelineWithStoredForms(lookup.pipeline)
					}
				}
			: stage;
	});
}
