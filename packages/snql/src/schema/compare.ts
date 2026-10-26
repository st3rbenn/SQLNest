/**
 * Contrôle de structure (ADR-037 D5) : le schéma attendu (`applyDdlToSchema`)
 * confronté à l'introspection d'après — tables, colonnes (type, nullabilité,
 * présence d'un défaut, valeurs d'enum), clé primaire, index, FK (cible,
 * actions), enums. Une liste vide : conforme.
 *
 * Le contrôle porte sur ce que le DDL touche (`ddlScope`) : ailleurs, un
 * échantillonnage Mongo peut varier d'une introspection à l'autre.
 */

import type { DDLPlan } from "../ir/plan";
import type {
	Collection,
	CollectionIndex,
	Field,
	RefDef,
	SchemaModel,
	SnqlType
} from "./model";

export interface SchemaDiff {
	/** Table ; l'enum pour `subject: "enum"`. */
	readonly target: string;
	readonly subject:
		| "table"
		| "column"
		| "primary-key"
		| "index"
		| "foreign-key"
		| "enum";
	/** Colonne, index ou FK. */
	readonly name?: string;
	readonly expected: string;
	readonly actual: string;
}

export interface SchemaScope {
	readonly collections: readonly string[];
	readonly enums: readonly string[];
}

/**
 * Types qu'un moteur rend à la place du type SNQL quand il n'a pas
 * d'équivalent natif (constaté sur les vraies bases).
 */
const ENGINE_REPRESENTATIONS: Readonly<
	Record<string, Partial<Record<SnqlType, readonly SnqlType[]>>>
> = {
	// Un tableau SNQL est rangé en jsonb.
	postgres: { array: ["json"] },
	// Ni JSON ni tableau en T-SQL : du texte JSON.
	mssql: { json: ["string"], array: ["string"] }
};

/** Ce qu'un plan DDL touche dans le schéma d'avant. */
export function ddlScope(plan: DDLPlan, before: SchemaModel): SchemaScope {
	switch (plan.kind) {
		case "create-enum":
		case "add-enum-member":
		case "drop-enum":
			return {
				collections: before.collections
					.filter((c) => c.fields.some((f) => f.enumTypeName === plan.name))
					.map((c) => c.name),
				enums: [plan.name]
			};
		default:
			return { collections: [plan.target], enums: [] };
	}
}

export function compareSchemas(
	expected: SchemaModel,
	actual: SchemaModel,
	scope?: SchemaScope
): SchemaDiff[] {
	const names = scope?.collections ?? [
		...new Set([
			...expected.collections.map((c) => c.name),
			...actual.collections.map((c) => c.name)
		])
	];
	const diffs: SchemaDiff[] = [];
	for (const name of names) {
		const want = expected.collections.find((c) => c.name === name);
		const got = actual.collections.find((c) => c.name === name);
		if (want === undefined && got === undefined) continue;
		if (want === undefined || got === undefined) {
			diffs.push({
				target: name,
				subject: "table",
				expected: want !== undefined ? "présente" : "absente",
				actual: got !== undefined ? "présente" : "absente"
			});
			continue;
		}
		diffs.push(
			...compareFields(want, got, actual.engine),
			...comparePrimaryKey(want, got, actual.engine),
			...compareIndexes(want, got),
			...compareRefs(name, expected.refs ?? [], actual.refs ?? [])
		);
	}
	const enums = scope?.enums ?? [
		...new Set([
			...(expected.enums ?? []).map((e) => e.name),
			...(actual.enums ?? []).map((e) => e.name)
		])
	];
	for (const name of enums) {
		const want = expected.enums?.find((e) => e.name === name)?.members;
		const got = actual.enums?.find((e) => e.name === name)?.members;
		const shown = (m: readonly string[] | undefined): string =>
			m !== undefined ? `[${m.join(", ")}]` : "absent";
		if (shown(want) !== shown(got)) {
			diffs.push({
				target: name,
				subject: "enum",
				expected: shown(want),
				actual: shown(got)
			});
		}
	}
	return diffs;
}

function compareFields(
	want: Collection,
	got: Collection,
	engine: string
): SchemaDiff[] {
	const diffs: SchemaDiff[] = [];
	const names = [
		...new Set([
			...want.fields.map((f) => f.name),
			...got.fields.map((f) => f.name)
		])
	];
	for (const name of names) {
		const w = want.fields.find((f) => f.name === name);
		const g = got.fields.find((f) => f.name === name);
		if (w === undefined || g === undefined) {
			// `_id` Mongo n'apparaît qu'avec des documents à échantillonner.
			if (engine === "mongodb" && isMongoId(w ?? g)) continue;
			diffs.push({
				target: want.name,
				subject: "column",
				name,
				expected: w !== undefined ? describeField(w) : "absente",
				actual: g !== undefined ? describeField(g) : "absente"
			});
			continue;
		}
		// Un champ inféré par échantillonnage n'est sûr que de sa présence.
		if (w.source === "inferred" || g.source === "inferred") continue;
		if (!sameField(w, g, engine)) {
			diffs.push({
				target: want.name,
				subject: "column",
				name,
				expected: describeField(w),
				actual: describeField(g)
			});
		}
	}
	return diffs;
}

function sameField(w: Field, g: Field, engine: string): boolean {
	const typeMatches =
		w.type === g.type ||
		(ENGINE_REPRESENTATIONS[engine]?.[w.type]?.includes(g.type) ?? false);
	return (
		typeMatches &&
		w.nullable === g.nullable &&
		(w.hasDefault === true) === (g.hasDefault === true) &&
		(w.enumValues === undefined ||
			w.enumValues.join("\u0000") === (g.enumValues ?? []).join("\u0000"))
	);
}

function comparePrimaryKey(
	want: Collection,
	got: Collection,
	engine: string
): SchemaDiff[] {
	const key = (c: Collection): string => {
		const pk = c.primaryKey ?? [];
		// Mongo : `_id` est la clé de toute collection, déclarée ou non.
		return engine === "mongodb" && pk.length === 1 && pk[0] === "_id"
			? ""
			: pk.join(", ");
	};
	return key(want) === key(got)
		? []
		: [
				{
					target: want.name,
					subject: "primary-key",
					expected: key(want) !== "" ? `(${key(want)})` : "aucune",
					actual: key(got) !== "" ? `(${key(got)})` : "aucune"
				}
			];
}

/**
 * Index appariés par nom ; un index attendu sans nom (choisi par le moteur)
 * l'est par ses colonnes et son unicité.
 */
function compareIndexes(want: Collection, got: Collection): SchemaDiff[] {
	const diffs: SchemaDiff[] = [];
	const remaining = [...(got.indexes ?? [])];
	const take = (
		match: (i: CollectionIndex) => boolean
	): CollectionIndex | undefined => {
		const at = remaining.findIndex(match);
		return at < 0 ? undefined : remaining.splice(at, 1)[0];
	};
	for (const w of want.indexes ?? []) {
		const g =
			w.name !== ""
				? take((i) => i.name === w.name)
				: take((i) => describeIndex(i) === describeIndex(w));
		if (g === undefined || describeIndex(g) !== describeIndex(w)) {
			diffs.push({
				target: want.name,
				subject: "index",
				...(w.name !== "" ? { name: w.name } : {}),
				expected: describeIndex(w),
				actual: g !== undefined ? describeIndex(g) : "absent"
			});
		}
	}
	for (const g of remaining) {
		diffs.push({
			target: want.name,
			subject: "index",
			name: g.name,
			expected: "absent",
			actual: describeIndex(g)
		});
	}
	return diffs;
}

function compareRefs(
	table: string,
	expected: readonly RefDef[],
	actual: readonly RefDef[]
): SchemaDiff[] {
	const want = expected.filter((r) => r.fromCollection === table);
	const got = actual.filter((r) => r.fromCollection === table);
	const names = [
		...new Set([...want.map((r) => r.name), ...got.map((r) => r.name)])
	];
	const diffs: SchemaDiff[] = [];
	for (const name of names) {
		const w = want.find((r) => r.name === name);
		const g = got.find((r) => r.name === name);
		const shown = (r: RefDef | undefined): string =>
			r !== undefined
				? `(${r.fromColumn}) → ${r.toCollection}.${r.toColumn}, on delete ${r.onDelete}, on update ${r.onUpdate}`
				: "absente";
		if (shown(w) !== shown(g)) {
			diffs.push({
				target: table,
				subject: "foreign-key",
				name,
				expected: shown(w),
				actual: shown(g)
			});
		}
	}
	return diffs;
}

function describeField(f: Field): string {
	return [
		f.type,
		f.nullable ? "nullable" : "non nul",
		...(f.hasDefault === true ? ["avec défaut"] : []),
		...(f.enumValues !== undefined ? [`[${f.enumValues.join(", ")}]`] : [])
	].join(", ");
}

function describeIndex(i: CollectionIndex): string {
	return `${i.unique ? "unique " : ""}(${i.columns.join(", ")})`;
}

function isMongoId(f: Field | undefined): boolean {
	return f !== undefined && (f.name === "_id" || f.nativeName === "_id");
}
