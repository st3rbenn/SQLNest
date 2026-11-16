import { SNQL_TYPE_ALIAS } from "../parser/parser";
import type { SchemaModel } from "../schema/model";

/**
 * Suggestions de base : mots-clés, tables, colonnes, types, clés étrangères,
 * enums.
 */

export type SnqlCompletionType =
	| "verb"
	| "keyword"
	| "collection"
	| "field"
	| "relation"
	| "alias"
	| "type";

export interface SnqlCompletion {
	/** Ce qui s'affiche dans la liste. */
	readonly label: string;
	readonly type: SnqlCompletionType;
	/** Annotation à droite (type du champ, cible d'une relation…). */
	readonly detail?: string;
	/** Texte réellement inséré si différent du label (ex. clause `on` complète). */
	readonly apply?: string;
	/**
	 * hint pour un renderer surface (CM6) qui veut fabriquer
	 * un apply function smart (auto-indent, guillemets pour string, curseur
	 * positionné). Absent = pas de smart-apply, le renderer insère `label` nu.
	 *  - "string" : type texte/uuid/enum — insérer `label: "|"` (curseur entre guillemets)
	 *  - "number" : type numeric/bool/date/json — insérer `label: |` (curseur après space)
	 *  - "raw"    : type inconnu — insérer `label: |` sans quotes
	 */
	readonly insertKind?: "string" | "number" | "raw";
}

export interface SnqlCompletionResult {
	/** Offset de début du mot courant : la zone que la complétion remplace. */
	readonly from: number;
	readonly options: readonly SnqlCompletion[];
}

/** Verbes proposés en début de requête (canonique par opération). */
const PRIMARY_VERBS: readonly {
	label: string;
	detail: string;
	type?: SnqlCompletionType;
}[] = [
	{ label: "get", detail: "lecture" },
	{ label: "add", detail: "insertion / DDL column / DDL index" },
	{ label: "update", detail: "mise à jour" },
	{ label: "remove", detail: "suppression" },
	// T3 introspection : soft-keywords, taggés `keyword` (pas verb CRUD) —
	// affichés avec l'icône keyword mais dans la même palette top-level.
	{ label: "list", detail: "introspection", type: "keyword" },
	{ label: "describe", detail: "introspection", type: "keyword" },
	// `raw` escape hatch — dernier recours documenté.
	{ label: "raw", detail: "escape hatch (SQL/Mongo brut)", type: "keyword" },
	// `let` — CTE binding, préfixe une requête plus grosse.
	{ label: "let", detail: "CTE (let x = find ...; body)", type: "keyword" },
	// DDL Tier-2 (ADR-029 DDL/5). `create` est verb insert-alias mais utile
	// aussi pour `create table T {...}` — le peek `table` route en DDL. `drop`
	// reste soft-ident (peekIdent au dispatch) — head-of-statement only.
	{ label: "create", detail: "DDL create table", type: "keyword" },
	{
		label: "drop",
		detail: "DDL drop table/column/index (destructif)",
		type: "keyword"
	},
	{ label: "rename", detail: "DDL rename column", type: "keyword" },
	{ label: "alter", detail: "DDL alter column", type: "keyword" }
];

/**
 * Types SNQL suggestibles après `<col>: ` dans un body `create table` ou
 * après `add column X ` (ADR-029 DDL/5). Source unique = `SNQL_TYPE_ALIAS`
 * exporté par parser.ts — évite la dérive complete ↔ parser. Ordre : d'abord
 * canoniques puis aliases PG paste-friendly, séparés visuellement par `detail`.
 */
export function ddlTypeSuggestions(
	schema?: SchemaModel
): readonly SnqlCompletion[] {
	const canonicals: ReadonlySet<string> = new Set([
		"string",
		"int",
		"bigint",
		"float",
		"decimal",
		"bool",
		"date",
		"json",
		"array",
		"uuid",
		"enum",
		"unknown"
	]);
	const builtins: SnqlCompletion[] = Object.keys(SNQL_TYPE_ALIAS).map(
		(label) => ({
			label,
			type: "keyword" as const,
			detail: canonicals.has(label)
				? "type SNQL"
				: `alias PG → ${SNQL_TYPE_ALIAS[label]}`
		})
	);
	// Enums en scope (ADR-030 Enum/2b) — proposés en plus des builtins.
	// `type: "type"` pour distinguer visuellement d'un keyword.
	const enums: SnqlCompletion[] =
		schema?.enums?.map((e) => ({
			label: e.name,
			type: "type" as const,
			detail: `enum (${e.members.length} members)`
		})) ?? [];
	return [...builtins, ...enums];
}

// --- Constructeurs de candidats ---------------------------------------------
export function verbs(): readonly SnqlCompletion[] {
	return PRIMARY_VERBS.map((v) => ({
		label: v.label,
		type: v.type ?? ("verb" as const),
		detail: v.detail
	}));
}

export function keyword(label: string): SnqlCompletion {
	return { label, type: "keyword" };
}

export function collections(schema: SchemaModel): readonly SnqlCompletion[] {
	return schema.collections.map((c) => ({
		label: c.name,
		type: "collection" as const,
		detail: `${c.fields.length} champ${c.fields.length > 1 ? "s" : ""}`
	}));
}

/** Champs d'une collection nommée (vide si inconnue). */
export function fieldsOf(
	schema: SchemaModel,
	collection: string | undefined
): readonly SnqlCompletion[] {
	if (collection === undefined) {
		return [];
	}
	const found = schema.collections.find((c) => c.name === collection);
	if (found === undefined) {
		return [];
	}
	return found.fields.map((f) => ({
		label: f.name,
		type: "field" as const,
		detail: f.nullable ? `${f.type} ?` : f.type
	}));
}

/** Colonnes de la collection cible d'une ref (V1 = toutes). */
export function refTargetColumns(
	schema: SchemaModel,
	collection: string
): readonly SnqlCompletion[] {
	const coll = schema.collections.find((c) => c.name === collection);
	if (coll === undefined) return [];
	return coll.fields.map((f) => ({
		label: f.name,
		type: "field" as const,
		detail: f.type
	}));
}

/**
 * FK déclarées en scope (ADR-031 FK/3) — labels = noms de contraintes,
 * detail = `from.col → to.col`. Contrairement aux index, les noms de refs
 * VIVENT dans le SchemaModel (`schema.refs`, PG pg_constraint / Mongo
 * `_snql_refs`) — l'user n'a pas à retrouver un auto-généré via raw.
 */
export function refSuggestions(schema: SchemaModel): readonly SnqlCompletion[] {
	return (
		schema.refs?.map((r) => ({
			label: r.name,
			type: "relation" as const,
			detail: `${r.fromCollection}.${r.fromColumn} → ${r.toCollection}.${r.toColumn}`
		})) ?? []
	);
}

/**
 * Enums en scope suggérés — miroir de `collections()`, distinct visuellement
 * par `type: "type"` + `detail: enum (N members)`.
 */
export function enumSuggestions(
	schema: SchemaModel
): readonly SnqlCompletion[] {
	return (
		schema.enums?.map((e) => ({
			label: e.name,
			type: "type" as const,
			detail: `enum (${e.members.length} members)`
		})) ?? []
	);
}
