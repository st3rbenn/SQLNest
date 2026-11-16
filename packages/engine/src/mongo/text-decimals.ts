import { isSqlDecimal } from "@sqlnest/snql";
import { Decimal128, type Document } from "mongodb";
import { isOperators } from "./stored-forms";

/**
 * Décimaux stockés en texte (Prisma) : convertis le temps d'un pipeline pour
 * comparer et calculer, puis rendus à leur forme d'origine.
 */

/** Un `decimal` rangé en texte, en Decimal128 ; un texte illisible reste tel quel. */
function textAsDecimal(field: string): Document {
	const path = `$${field}`;
	return {
		$cond: [
			{ $eq: [{ $type: path }, "string"] },
			{ $convert: { input: path, to: "decimal", onError: path } },
			path
		]
	};
}

/** Collections visées par les `$lookup` d'un pipeline, sous-pipelines compris. */
export function lookupCollections(
	stages: readonly Document[],
	out: Set<string> = new Set()
): Set<string> {
	for (const stage of stages) {
		const lookup = stage.$lookup as Document | undefined;
		if (lookup === undefined) continue;
		if (typeof lookup.from === "string") out.add(lookup.from);
		if (Array.isArray(lookup.pipeline)) lookupCollections(lookup.pipeline, out);
	}
	return out;
}

/**
 * Pipeline où chaque `decimal` rangé en texte (ADR-036 D6) se lit comme un
 * nombre : comparé, trié, sommé et calculé sur sa valeur, rendu comme un
 * decimal. Le champ passe en Decimal128 en tête du pipeline, et en tête du
 * sous-pipeline d'un `$lookup` vers une collection qui en a.
 */
export function withTextDecimalStages(
	stages: readonly Document[],
	fields: readonly string[],
	fieldsOf: (collection: string) => readonly string[]
): Document[] {
	const out = stages.map((stage) => {
		const lookup = stage.$lookup as Document | undefined;
		if (lookup === undefined || typeof lookup.from !== "string") return stage;
		const inner = Array.isArray(lookup.pipeline)
			? (lookup.pipeline as Document[])
			: [];
		const next = withTextDecimalStages(inner, fieldsOf(lookup.from), fieldsOf);
		return next.length === 0
			? stage
			: { ...stage, $lookup: { ...lookup, pipeline: next } };
	});
	if (fields.length === 0) return out;
	return [
		{
			$addFields: Object.fromEntries(fields.map((f) => [f, textAsDecimal(f)]))
		},
		...out
	];
}

/** Étape qui ramène au texte les `decimal` rangés en texte, avant d'écrire. */
export function decimalsBackToText(fields: readonly string[]): Document {
	return {
		$set: Object.fromEntries(
			fields.map((f) => [
				f,
				{ $cond: [{ $isNumber: `$${f}` }, { $toString: `$${f}` }, `$${f}`] }
			])
		)
	};
}

/** `stage` inséré avant le `$merge` final d'un pipeline d'écriture. */
export function beforeMerge(
	stages: readonly Document[],
	stage: Document
): Document[] {
	const last = stages.at(-1);
	return last?.$merge !== undefined
		? [...stages.slice(0, -1), stage, last]
		: [...stages, stage];
}

const DECIMAL_COMPARE = new Set(["$eq", "$ne", "$gt", "$gte", "$lt", "$lte"]);

/** Borne d'un filtre en Decimal128, pour la comparer exactement à un décimal. */
function decimalBound(value: unknown): unknown {
	const text = isSqlDecimal(value)
		? value.raw
		: typeof value === "number" && Number.isFinite(value)
			? String(value)
			: typeof value === "bigint"
				? value.toString()
				: typeof value === "string"
					? value.trim()
					: undefined;
	if (text === undefined) return value;
	try {
		return Decimal128.fromString(text);
	} catch {
		return value;
	}
}

/**
 * Filtre d'écriture où une condition sur un `decimal` rangé en texte compare
 * sa valeur, en Decimal128 sous `$expr` (ADR-036 D6). `null`, `$exists` et
 * les autres opérateurs restent des conditions de champ.
 */
export function withTextDecimalFilter(
	filter: Document,
	fields: ReadonlySet<string>
): Document {
	if (fields.size === 0) return filter;
	const out: Document = {};
	const exprs: Document[] = [];
	for (const [key, value] of Object.entries(filter)) {
		if (key === "$and" || key === "$or" || key === "$nor") {
			out[key] = Array.isArray(value)
				? value.map((q) => withTextDecimalFilter(q as Document, fields))
				: value;
			continue;
		}
		if (!fields.has(key) || value === null) {
			out[key] = value;
			continue;
		}
		const field = {
			$convert: { input: `$${key}`, to: "decimal", onError: null, onNull: null }
		};
		const operators = isOperators(value);
		const kept: Document = {};
		for (const [op, v] of operators
			? Object.entries(value)
			: [["$eq", value]]) {
			if (DECIMAL_COMPARE.has(op as string) && v !== null) {
				exprs.push({ [op as string]: [field, decimalBound(v)] });
			} else if (
				(op === "$in" || op === "$nin") &&
				Array.isArray(v) &&
				!v.includes(null)
			) {
				const member = { $in: [field, v.map(decimalBound)] };
				exprs.push(op === "$in" ? member : { $not: [member] });
			} else {
				kept[op as string] = v;
			}
		}
		if (Object.keys(kept).length > 0) out[key] = operators ? kept : value;
	}
	if (exprs.length === 0) return out;
	const all =
		out.$expr !== undefined ? [out.$expr as Document, ...exprs] : exprs;
	return { ...out, $expr: all.length === 1 ? all[0] : { $and: all } };
}
