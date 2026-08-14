/**
 * Inférence des types des colonnes de sortie d'une query SNQL — pur, sans I/O.
 *
 * Étant donné un `PhysicalPlan` (compilé par `planFor()` ou `plan()`) et un
 * `SchemaModel` (introspection), retourne le shape des colonnes du résultat
 * final : nom + `SnqlType` + `nullable`. Utilisé côté CLI juste avant de
 * packer la réponse `runSnql` pour que le frontend puisse afficher les
 * badges de type (bigint / string / bool / date) dans les headers de table.
 *
 * ─── Cases supportés ─────────────────────────────────────────────────────
 *   get <coll>                       → toutes les colonnes de la collection
 *   get <coll> pick a, b           → a et b (typés depuis le schéma)
 *   get <coll> as u pick u.email   → email typé (alias source strippé)
 *   get a with b as x on ... pick x  → x typé "array" (join embed)
 *   get a with b as x on ... pick x.field  → unknown (nested paths V2)
 *   get <coll> | filter/sort/limit ... → transparent (pass-through)
 *
 * ─── Fallback ────────────────────────────────────────────────────────────
 * Toute résolution qui échoue (collection/field absent du schéma, chemin
 * imbriqué non-analysable) retourne `type: "unknown"` + `nullable: true`.
 * Aucune exception jetée — la fonction est safe à appeler pour n'importe
 * quel plan valide.
 */

import type { CastTarget, LogicalPlan, PlanProjectField } from "../ir/plan";
import { linearize } from "../ir/plan";
import type { CompensationOp, PhysicalPlan } from "../planner/planner";
import type { Collection, Field, SchemaModel, SnqlType } from "../schema/model";
import type { ResultColumn } from "./result";

/**
 * Mapping runtime des 7 targets canoniques SNQL vers le vocabulaire `SnqlType`
 * de l'introspection. Choix pragmatique : on rapproche du plus proche existant
 * plutôt que d'introduire un nouveau vocabulaire — les consommateurs
 * (frontend badges) restent inchangés.
 */
const CAST_TO_SNQL_TYPE: Readonly<Record<CastTarget, SnqlType>> = {
	int: "bigint",
	float: "float",
	text: "string",
	bool: "bool",
	date: "date",
	timestamp: "date",
	json: "json"
};

/** Colonne enrichie de sa collection d'origine (utile pour walker les ops). */
interface WorkingCol {
	readonly name: string;
	readonly type: SnqlType;
	readonly nullable: boolean;
	/** Vide pour les colonnes computed (join array, expressions). */
	readonly collection: string;
}

/** État walker : suivi de la source + aliases + colonnes courantes. */
interface InferState {
	sourceCollection: string;
	sourceAlias: string | undefined;
	/** alias → nom réel de la collection jointe (ex: `x` → `orders`). */
	joinAliases: Map<string, string>;
	cols: WorkingCol[];
}

const UNKNOWN_FIELD = { type: "unknown" as SnqlType, nullable: true } as const;

export function inferResultColumns(
	physical: PhysicalPlan,
	schema: SchemaModel
): readonly ResultColumn[] {
	const pushedOps = linearize(physical.pushdown);
	const scan = pushedOps[0];
	if (scan === undefined || scan.op !== "scan") {
		// Plan invalide (le planner l'aurait rejeté), safe fallback.
		return [];
	}

	const sourceCollection = findCollection(schema, scan.collection);
	const state: InferState = {
		sourceCollection: scan.collection,
		sourceAlias: scan.alias,
		joinAliases: new Map(),
		cols: sourceCollection
			? sourceCollection.fields.map((f) => ({
					name: f.name,
					type: f.type,
					nullable: f.nullable,
					collection: scan.collection
				}))
			: []
	};

	// pushedOps[0] est le scan (déjà consommé), on itère à partir de [1].
	for (let i = 1; i < pushedOps.length; i += 1) {
		const op = pushedOps[i];
		if (op !== undefined) applyLogical(state, op, schema);
	}
	for (const comp of physical.compensation) {
		applyCompensation(state, comp, schema);
	}

	return state.cols.map((c) => ({
		name: c.name,
		type: c.type,
		nullable: c.nullable
	}));
}

function applyLogical(
	state: InferState,
	op: LogicalPlan,
	schema: SchemaModel
): void {
	switch (op.op) {
		case "scan":
			// Un scan ne peut apparaître qu'en position 0 — s'il resurgit ici,
			// le plan est mal formé. On ignore (safe).
			return;
		case "filter":
		case "sort":
		case "limit":
			// Transparents pour le shape des colonnes.
			return;
		case "project":
		case "aggregate":
			// Sprint T2/6 : aggregate projette les mêmes fields que project (une
			// seule row output sprint 6). Le type inference dispatch sur call
			// kind='aggregate' pour retourner bigint/float selon la fonction.
			state.cols = projectFields(op.fields, state, schema);
			return;
		case "join":
			state.joinAliases.set(op.as, op.collection);
			// Join embed : ajoute une colonne `as` de type array (tableau des
			// lignes matchées, coalesced à [] côté PG → non-null par contrat).
			state.cols = [
				...state.cols,
				{
					name: op.as,
					type: "array",
					nullable: false,
					collection: op.collection
				}
			];
			return;
	}
}

function applyCompensation(
	state: InferState,
	op: CompensationOp,
	schema: SchemaModel
): void {
	switch (op.op) {
		case "filter":
		case "sort":
		case "limit":
			return;
		case "project":
		case "aggregate":
			state.cols = projectFields(op.fields, state, schema);
			return;
		case "join":
			state.joinAliases.set(op.as, op.collection);
			state.cols = [
				...state.cols,
				{
					name: op.as,
					type: "array",
					nullable: false,
					collection: op.collection
				}
			];
			return;
	}
}

function projectFields(
	fields: readonly PlanProjectField[],
	state: InferState,
	schema: SchemaModel
): WorkingCol[] {
	return fields.map((f) => resolveProjectField(f, state, schema));
}

/**
 * Convention nom de sortie alignée sur `lower.ts:171-178` +
 * `codegen/mongodb.ts:174-182` : `alias ?? path[path.length - 1] ?? ""`.
 */
function resolveProjectField(
	field: PlanProjectField,
	state: InferState,
	schema: SchemaModel
): WorkingCol {
	const outputName =
		field.alias ?? field.path[field.path.length - 1] ?? "";

	// `pick cast(x as T) as y` : le target du cast est un signal statique fort,
	// on mappe vers SnqlType plutôt que de perdre l'info en 'unknown'. Un cast
	// est non-null par contrat sauf si son operand est NULL — au niveau colonne,
	// on marque nullable=true pour ne pas mentir (l'operand peut être NULL).
	if (field.expr?.kind === "cast") {
		return {
			name: outputName,
			type: CAST_TO_SNQL_TYPE[field.expr.target],
			nullable: true,
			collection: ""
		};
	}

	// Sprint T2/6-7 : agrégats scalaires — signal type fort.
	//  - count → bigint (parité PG bigint natif ; KV Number sub-2^53 quand
	//    même bigint sémantiquement, doc knownDivergences).
	//  - sum/avg → float (cast ::double precision dans pgSum/pgAvg pour
	//    préserver typeof number consumer JS).
	//  - min/max → type de args[0] (résolu depuis field si path, sinon
	//    unknown pour expressions complexes).
	if (field.expr?.kind === "call") {
		const callName = field.expr.name;
		if (callName === "count") {
			return {
				name: outputName,
				type: "bigint",
				nullable: false,
				collection: ""
			};
		}
		if (callName === "sum" || callName === "avg") {
			return {
				name: outputName,
				type: "float",
				nullable: true,
				collection: ""
			};
		}
		if (callName === "min" || callName === "max") {
			// Résoudre le type depuis args[0] si c'est un field ref simple.
			// Aggregate skip null → nullable:true toujours (empty group).
			const arg = field.expr.args[0];
			if (arg?.kind === "field") {
				const resolved = resolveFieldType(arg.path, state, schema);
				if (resolved !== null) {
					return {
						name: outputName,
						type: resolved,
						nullable: true,
						collection: ""
					};
				}
			}
			return {
				name: outputName,
				...UNKNOWN_FIELD,
				collection: ""
			};
		}
		// Sprint T2/8 : aggregateMulti — types de retour forts.
		//  - array_agg → array (nullable côté PG empty group, [] côté KV)
		//  - string_agg → string (nullable côté PG empty group, "" côté KV)
		//  - json_agg → json
		if (callName === "array_agg") {
			return {
				name: outputName,
				type: "array",
				nullable: true,
				collection: ""
			};
		}
		if (callName === "string_agg") {
			return {
				name: outputName,
				type: "string",
				nullable: true,
				collection: ""
			};
		}
		if (callName === "json_agg") {
			return {
				name: outputName,
				type: "json",
				nullable: true,
				collection: ""
			};
		}
	}

	// Sprint object-literals : `pick {n: r.name} as doc` ou `pick [...] as arr`
	// → type 'json' statique. Retour non-null par construction (le literal est
	// toujours défini, indépendamment des valeurs qu'il contient).
	if (field.expr?.kind === "object" || field.expr?.kind === "array") {
		return {
			name: outputName,
			type: "json",
			nullable: false,
			collection: ""
		};
	}

	if (field.path.length === 0) {
		return { name: outputName, ...UNKNOWN_FIELD, collection: "" };
	}

	// Chemin nu de longueur 1 : soit alias d'un join (→ type array), soit
	// field de la collection source, sinon fallback.
	if (field.path.length === 1) {
		const name = field.path[0];
		if (name === undefined) {
			return { name: outputName, ...UNKNOWN_FIELD, collection: "" };
		}
		if (state.joinAliases.has(name)) {
			return {
				name: outputName,
				type: "array",
				nullable: false,
				collection: state.joinAliases.get(name) ?? ""
			};
		}
		const resolved = findField(schema, state.sourceCollection, name);
		return resolved
			? {
					name: outputName,
					type: resolved.type,
					nullable: resolved.nullable,
					collection: state.sourceCollection
				}
			: { name: outputName, ...UNKNOWN_FIELD, collection: "" };
	}

	// path.length >= 2 : préfixe = alias source OU alias join, sinon chemin
	// imbriqué (Mongo nested doc) qu'on ne résout pas en V1.
	const [prefix, ...rest] = field.path;
	if (prefix === undefined) {
		return { name: outputName, ...UNKNOWN_FIELD, collection: "" };
	}

	// Cas alias source : `get users as u pick u.email`
	if (prefix === state.sourceAlias) {
		if (rest.length === 1) {
			const name = rest[0];
			if (name === undefined) {
				return { name: outputName, ...UNKNOWN_FIELD, collection: "" };
			}
			const resolved = findField(schema, state.sourceCollection, name);
			return resolved
				? {
						name: outputName,
						type: resolved.type,
						nullable: resolved.nullable,
						collection: state.sourceCollection
					}
				: { name: outputName, ...UNKNOWN_FIELD, collection: "" };
		}
		// alias.nested.path → chemin imbriqué, V1 = unknown
		return { name: outputName, ...UNKNOWN_FIELD, collection: "" };
	}

	// Cas alias join : `pick x.field` avec `with orders as x`
	const joinedCollection = state.joinAliases.get(prefix);
	if (joinedCollection !== undefined) {
		if (rest.length === 1) {
			const name = rest[0];
			if (name === undefined) {
				return { name: outputName, ...UNKNOWN_FIELD, collection: "" };
			}
			const resolved = findField(schema, joinedCollection, name);
			return resolved
				? {
						name: outputName,
						type: resolved.type,
						nullable: resolved.nullable,
						collection: joinedCollection
					}
				: { name: outputName, ...UNKNOWN_FIELD, collection: "" };
		}
		return { name: outputName, ...UNKNOWN_FIELD, collection: "" };
	}

	// Préfixe inconnu (chemin imbriqué Mongo `address.city` ou similaire) →
	// on ne tente pas de résoudre en V1.
	return { name: outputName, ...UNKNOWN_FIELD, collection: "" };
}

/**
 * Sprint T2/7 : résout le SnqlType d'un field ref path (utilisé par min/max).
 * Traverse alias source, alias join. Retourne null si non résolvable (nested
 * paths, préfixe inconnu, schema pas dispo, etc).
 */
function resolveFieldType(
	path: readonly string[],
	state: InferState,
	schema: SchemaModel
): SnqlType | null {
	if (path.length === 0) return null;
	if (path.length === 1) {
		const name = path[0]!;
		if (state.joinAliases.has(name)) return "array";
		const resolved = findField(schema, state.sourceCollection, name);
		return resolved?.type ?? null;
	}
	const [prefix, ...rest] = path;
	if (prefix === undefined) return null;
	if (prefix === state.sourceAlias && rest.length === 1) {
		const resolved = findField(schema, state.sourceCollection, rest[0]!);
		return resolved?.type ?? null;
	}
	const joined = state.joinAliases.get(prefix);
	if (joined !== undefined && rest.length === 1) {
		const resolved = findField(schema, joined, rest[0]!);
		return resolved?.type ?? null;
	}
	return null;
}

function findCollection(
	schema: SchemaModel,
	name: string
): Collection | undefined {
	return schema.collections.find((c) => c.name === name);
}

function findField(
	schema: SchemaModel,
	collectionName: string,
	fieldName: string
): Field | undefined {
	const coll = findCollection(schema, collectionName);
	if (coll === undefined) return undefined;
	return coll.fields.find((f) => f.name === fieldName);
}
