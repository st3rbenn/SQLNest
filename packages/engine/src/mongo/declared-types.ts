import { isSqlDecimal } from "@sqlnest/snql";
import type { Document } from "mongodb";
import { Decimal128, Double, Int32, Long, ObjectId, UUID } from "mongodb";
import { EngineExecutionError } from "../errors";

/**
 * Type BSON déclaré de chaque champ, lu du validateur `$jsonSchema` : c'est
 * lui qui refuse un document mal typé (ADR-029 D15). `null` est retiré d'une
 * union `[t, "null"]` ; un champ à plusieurs types n'est pas converti.
 */
export type DeclaredTypes = ReadonlyMap<string, string>;

export function declaredTypes(validator: Document | undefined): DeclaredTypes {
	const jsonSchema = validator?.$jsonSchema as Document | undefined;
	const properties = jsonSchema?.properties as Document | undefined;
	const out = new Map<string, string>();
	for (const [field, property] of Object.entries(properties ?? {})) {
		const bsonType = (property as { bsonType?: unknown } | null)?.bsonType;
		const types = (Array.isArray(bsonType) ? bsonType : [bsonType]).filter(
			(t) => t !== "null"
		);
		if (types.length === 1 && typeof types[0] === "string") {
			out.set(field, types[0]);
		}
	}
	return out;
}

/** Lecture d'un texte en booléen, mots acceptés par Postgres (`'f'::boolean`).
 *  `$convert` rendrait `true` pour tout texte non vide, `"false"` compris. */
export const BOOL_TRUE = ["true", "t", "yes", "y", "on", "1"];
export const BOOL_FALSE = ["false", "f", "no", "n", "off", "0"];

/** Nom SNQL d'un type du validateur, pour les messages. */
const SNQL_NAMES: Readonly<Record<string, string>> = {
	int: "int",
	long: "bigint",
	double: "float",
	decimal: "decimal",
	string: "string",
	bool: "bool",
	date: "date",
	binData: "uuid",
	object: "json",
	array: "array"
};

/** Valeur qu'un type refuse, avec la précision du message. */
class Refused {
	constructor(readonly detail?: string) {}
}

const INVALID = new Refused();
const FRACTION = new Refused("valeur non entière");
const OUT_OF_RANGE = new Refused("hors plage");

const INT32 = { min: -(2n ** 31n), max: 2n ** 31n - 1n };
const INT64 = { min: -(2n ** 63n), max: 2n ** 63n - 1n };

const DECIMAL_TEXT = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;
const DECIMAL_PARTS = /^([+-]?)(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/i;
const LEADING_ZEROS = /^0+/;

/** Texte d'un nombre JS ; un entier ≥ 1e21 écrit en chiffres, pas `1e+21`. */
function numberText(value: number): string {
	return Number.isInteger(value) && Math.abs(value) >= 1e21
		? BigInt(value).toString()
		: String(value);
}

/**
 * Texte décimal d'une valeur numérique : nombre ou `bigint` JS, littéral
 * décimal exact, nombre BSON lu en base, texte numérique.
 */
function decimalText(value: unknown): string | undefined {
	if (typeof value === "number") {
		return Number.isFinite(value) ? numberText(value) : undefined;
	}
	if (typeof value === "bigint") return value.toString();
	if (isSqlDecimal(value)) return value.raw;
	const text =
		typeof value === "string"
			? value.trim()
			: value instanceof Long ||
					value instanceof Int32 ||
					value instanceof Double ||
					value instanceof Decimal128
				? value.toString()
				: undefined;
	return text !== undefined && DECIMAL_TEXT.test(text) ? text : undefined;
}

/** Entier exact d'un texte décimal (`2.50e1` → 25). */
function integerOfText(text: string): bigint | Refused {
	const [, sign, whole = "", fraction = "", exponent = "0"] =
		DECIMAL_PARTS.exec(text) ?? [];
	let digits = `${whole}${fraction}`.replace(LEADING_ZEROS, "");
	let scale = Number(exponent) - fraction.length;
	while (scale < 0 && digits.endsWith("0")) {
		digits = digits.slice(0, -1);
		scale += 1;
	}
	if (digits === "") return 0n;
	if (scale < 0) return FRACTION;
	// Au-delà de 20 chiffres, hors de toute plage entière BSON.
	if (digits.length + scale > 20) return OUT_OF_RANGE;
	const value = BigInt(`${digits}${"0".repeat(scale)}`);
	return sign === "-" ? -value : value;
}

function toInteger(
	value: unknown,
	range: { readonly min: bigint; readonly max: bigint },
	wrap: (n: bigint) => unknown
): unknown {
	let n: bigint | Refused;
	if (typeof value === "bigint") n = value;
	else if (typeof value === "number" && Number.isFinite(value)) {
		n = Number.isInteger(value) ? BigInt(value) : FRACTION;
	} else {
		const text = decimalText(value);
		n = text === undefined ? INVALID : integerOfText(text);
	}
	if (n instanceof Refused) return n;
	return n < range.min || n > range.max ? OUT_OF_RANGE : wrap(n);
}

function toDouble(value: unknown): unknown {
	if (value instanceof Double) return value;
	if (typeof value === "number") return new Double(value);
	const text = decimalText(value);
	if (text === undefined) return INVALID;
	const n = Number(text);
	return Number.isFinite(n) ? new Double(n) : OUT_OF_RANGE;
}

function toDecimal(value: unknown): unknown {
	if (value instanceof Decimal128) return value;
	const text = decimalText(value);
	if (text === undefined) return INVALID;
	try {
		return Decimal128.fromString(text);
	} catch {
		return new Refused("plus de 34 chiffres significatifs");
	}
}

function toText(value: unknown): unknown {
	if (typeof value === "string") return value;
	if (typeof value === "boolean") return String(value);
	if (value instanceof Date) return value.toISOString();
	if (value instanceof UUID || value instanceof ObjectId)
		return value.toHexString();
	return decimalText(value) ?? INVALID;
}

function toBool(value: unknown): unknown {
	if (typeof value === "boolean") return value;
	if (typeof value !== "string") return INVALID;
	const word = value.trim().toLowerCase();
	if (BOOL_TRUE.includes(word)) return true;
	return BOOL_FALSE.includes(word) ? false : INVALID;
}

/** Date ISO 8601 ; sans fuseau, l'heure est UTC (une date BSON est un instant UTC). */
const ISO_DATE =
	/^(\d{4})-(\d{2})-(\d{2})(?:[t ](\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?)?\s*(?:(z)|([+-])(\d{2}):?(\d{2})?)?$/i;

function toDate(value: unknown): unknown {
	if (value instanceof Date) return value;
	if (typeof value !== "string") return INVALID;
	const m = ISO_DATE.exec(value.trim());
	if (m === null) return INVALID;
	const [year, month, day, hour, minute, second] = m
		.slice(1, 7)
		.map((part) => Number(part ?? 0)) as [
		number,
		number,
		number,
		number,
		number,
		number
	];
	const ms = Math.floor(Number(`0${m[7] ?? ""}`) * 1000);
	const date = new Date(0);
	date.setUTCFullYear(year, month - 1, day);
	date.setUTCHours(hour, minute, second, ms);
	if (
		date.getUTCFullYear() !== year ||
		date.getUTCMonth() !== month - 1 ||
		date.getUTCDate() !== day ||
		hour > 23 ||
		minute > 59 ||
		second > 59
	) {
		return INVALID;
	}
	// Groupes 9 à 11 : signe, heures et minutes du décalage.
	const sign = m[9];
	if (sign === undefined) return date;
	const offset =
		(Number(m[10]) * 60 + Number(m[11] ?? 0)) * (sign === "-" ? -1 : 1);
	return new Date(date.getTime() - offset * 60_000);
}

const BRACED = /^\{(.*)\}$/;

function toUuid(value: unknown): unknown {
	if (value instanceof UUID) return value;
	if (typeof value !== "string") return INVALID;
	const text = value.trim().replace(BRACED, "$1");
	return UUID.isValid(text) ? new UUID(text) : INVALID;
}

/** Texte JSON d'un objet ou d'un tableau, comme l'entrée d'un `jsonb` Postgres. */
function parsedJson(
	value: unknown,
	isTarget: (v: unknown) => boolean
): unknown {
	if (isTarget(value)) return value;
	if (typeof value === "string") {
		try {
			const parsed: unknown = JSON.parse(value);
			if (isTarget(parsed)) return parsed;
		} catch {
			// texte non JSON : refusé ci-dessous
		}
	}
	return INVALID;
}

function isPlainObject(value: unknown): boolean {
	return (
		value !== null &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		!(value instanceof Date) &&
		(value as { _bsontype?: unknown })._bsontype === undefined &&
		!isSqlDecimal(value)
	);
}

const OBJECT_ID_HEX = /^[0-9a-fA-F]{24}$/;

/** Conversion vers chaque type du validateur ; un type absent garde la valeur. */
const CONVERTERS: Readonly<Record<string, (value: unknown) => unknown>> = {
	int: (v) => toInteger(v, INT32, Number),
	long: (v) => toInteger(v, INT64, (n) => Long.fromBigInt(n)),
	double: toDouble,
	decimal: toDecimal,
	string: toText,
	bool: toBool,
	date: toDate,
	binData: toUuid,
	object: (v) => parsedJson(v, isPlainObject),
	array: (v) => parsedJson(v, Array.isArray),
	objectId: (v) =>
		v instanceof ObjectId
			? v
			: typeof v === "string" && OBJECT_ID_HEX.test(v)
				? new ObjectId(v)
				: INVALID
};

function shown(value: unknown): string {
	if (typeof value === "bigint") return value.toString();
	if (isSqlDecimal(value)) return value.raw;
	if (value instanceof Date) return value.toISOString();
	if ((value as { _bsontype?: unknown } | null)?._bsontype !== undefined) {
		return String(value);
	}
	return (
		JSON.stringify(value, (_key, v: unknown) =>
			typeof v === "bigint" ? v.toString() : v
		) ?? String(value)
	);
}

/** `value` au type BSON `bsonType` ; `ok: false` si elle n'y entre pas. */
export function convertValue(
	value: unknown,
	bsonType: string
): { readonly ok: boolean; readonly value?: unknown } {
	const convert = CONVERTERS[bsonType];
	if (convert === undefined || value === null || value === undefined) {
		return { ok: true, value };
	}
	const converted = convert(value);
	return converted instanceof Refused
		? { ok: false }
		: { ok: true, value: converted };
}

/**
 * `value` au type BSON déclaré de `column` (ADR-029 D15), sinon refus nommé :
 * `insert dans 't' : 'b' (bigint) n'accepte pas 1.5 — valeur non entière`.
 * `null` passe : la nullabilité reste l'affaire du validateur.
 */
export function toDeclaredType(
	value: unknown,
	bsonType: string,
	column: string,
	where: string
): unknown {
	if (value === null || value === undefined) return value;
	const convert = CONVERTERS[bsonType];
	if (convert === undefined) return value;
	const converted = convert(value);
	if (!(converted instanceof Refused)) return converted;
	const detail = converted.detail !== undefined ? ` — ${converted.detail}` : "";
	throw new EngineExecutionError(
		`${where} : '${column}' (${SNQL_NAMES[bsonType] ?? bsonType}) n'accepte pas ${shown(value)}${detail}`
	);
}

/** Champs déclarés d'un document convertis à leur type ; le reste est gardé. */
export function toDeclaredTypes<T extends object>(
	doc: T,
	types: DeclaredTypes,
	where: string
): T {
	let out: Record<string, unknown> | undefined;
	for (const [column, value] of Object.entries(doc)) {
		const bsonType = types.get(column);
		if (bsonType === undefined) continue;
		const converted = toDeclaredType(value, bsonType, column, where);
		if (converted !== value) {
			out ??= { ...(doc as Record<string, unknown>) };
			out[column] = converted;
		}
	}
	return (out ?? doc) as T;
}

/**
 * Expression d'agrégation qui ramène une valeur calculée côté serveur au type
 * déclaré : nombre vers float ou decimal, nombre entier vers int ou bigint,
 * scalaire vers texte — les conversions qu'une affectation Postgres fait
 * d'elle-même. Le reste passe tel quel et le validateur tranche.
 */
export function declaredTypeExpr(input: unknown, bsonType: string): unknown {
	const v = "$$v";
	const integral = { $and: [{ $isNumber: v }, { $eq: [v, { $trunc: v }] }] };
	const converted: Readonly<Record<string, unknown>> = {
		int: { $cond: [integral, { $toInt: v }, v] },
		long: { $cond: [integral, { $toLong: v }, v] },
		double: { $cond: [{ $isNumber: v }, { $toDouble: v }, v] },
		// Un double passe par son texte : `$toDecimal` en garderait 15 chiffres
		// (0.1 → 0.100000000000000).
		decimal: {
			$cond: [
				{ $eq: [{ $type: v }, "double"] },
				{ $toDecimal: { $toString: v } },
				{ $cond: [{ $isNumber: v }, { $toDecimal: v }, v] }
			]
		},
		string: {
			$cond: [
				{
					$in: [
						{ $type: v },
						["int", "long", "double", "decimal", "bool", "date", "objectId"]
					]
				},
				{ $toString: v },
				v
			]
		}
	};
	const expr = converted[bsonType];
	return expr === undefined
		? input
		: { $let: { vars: { v: input }, in: expr } };
}

/** Opérande littéral d'une expression d'agrégation (pas un chemin `$champ`). */
function isLiteralOperand(value: unknown): boolean {
	if (typeof value === "string") return !value.startsWith("$");
	if (value === null || typeof value !== "object") return true;
	return (
		value instanceof Date ||
		isSqlDecimal(value) ||
		(value as { _bsontype?: unknown })._bsontype !== undefined
	);
}

/** Valeur d'un `$set` en forme pipeline, au type déclaré. */
function declaredOperand(
	value: unknown,
	bsonType: string,
	column: string,
	where: string
): unknown {
	const wrapped =
		isPlainObject(value) &&
		Object.keys(value as Document).join() === "$literal";
	if (!wrapped && !isLiteralOperand(value))
		return declaredTypeExpr(value, bsonType);
	const literal = wrapped ? (value as { $literal: unknown }).$literal : value;
	const converted = toDeclaredType(literal, bsonType, column, where);
	// Un tableau, un objet ou un texte `$…` seraient lus comme des expressions.
	return isLiteralOperand(converted) ? converted : { $literal: converted };
}

/** `$set` / `$addFields` d'un pipeline d'écriture, champs déclarés au type. */
export function declaredPipeline(
	stages: readonly Document[],
	types: DeclaredTypes,
	where: string
): Document[] {
	return stages.map((stage) => {
		for (const op of ["$set", "$addFields"]) {
			const fields = stage[op] as Document | undefined;
			if (fields === undefined) continue;
			const out: Document = {};
			for (const [column, value] of Object.entries(fields)) {
				const bsonType = types.get(column);
				out[column] =
					bsonType === undefined
						? value
						: declaredOperand(value, bsonType, column, where);
			}
			return { ...stage, [op]: out };
		}
		return stage;
	});
}

/** Valeurs d'un update au type déclaré : `$set` littéral ou forme pipeline. */
export function declaredUpdate(
	update: Document | readonly Document[],
	types: DeclaredTypes,
	where: string
): Document | Document[] {
	if (Array.isArray(update)) return declaredPipeline(update, types, where);
	const set = (update as Document).$set as Document | undefined;
	return set === undefined
		? (update as Document)
		: { ...update, $set: toDeclaredTypes(set, types, where) };
}
