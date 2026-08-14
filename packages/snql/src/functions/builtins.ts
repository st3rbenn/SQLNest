/**
 * Assemblage des 8 builtins T2 sprint 1. Chaque entrée porte : nom canonique,
 * arité, types d'args opt-in, et les renderers par engine.
 *
 * Ce corpus minimal exerce 100% des modes d'arité :
 *  - fixe 1 arg : upper, lower, length, abs
 *  - range (1..2) : round
 *  - variadic min 2 : coalesce
 *  - 0 arg : now
 *  - variadic min 1 : concat
 *
 * Kind reste `scalar` pour tous — les agrégats (count/sum/avg) arrivent en T3
 * avec le grouping, marqués `aggregate` dans le registre à ce moment-là.
 */

import { extractStaticDotPath } from "./builtins-shared";
import {
	kvArrayAgg,
	kvAvg,
	kvCoalesce,
	kvCount,
	kvGreatest,
	kvIf,
	kvJsonAgg,
	kvLeast,
	kvMax,
	kvMin,
	kvNullif,
	kvStringAgg,
	kvSum
} from "./builtins.kv";
import {
	mongoAbs,
	mongoArrayAgg,
	mongoAvg,
	mongoCeil,
	mongoConcat,
	mongoCoalesce,
	mongoCount,
	mongoDateAdd,
	mongoDateDiff,
	mongoDatePart,
	mongoDateTrunc,
	mongoFloor,
	mongoGreatest,
	mongoIf,
	mongoJsonAgg,
	mongoJsonGet,
	mongoJsonGetText,
	mongoJsonHasKey,
	mongoJsonTypeof,
	mongoLeast,
	mongoLength,
	mongoLower,
	mongoLtrim,
	mongoMax,
	mongoMin,
	mongoNow,
	mongoNullif,
	mongoReplace,
	mongoRound,
	mongoRtrim,
	mongoStringAgg,
	mongoStrpos,
	mongoSubstring,
	mongoSum,
	mongoToday,
	mongoTrim,
	mongoUpper
} from "./builtins.mongo";
import {
	pgAbs,
	pgArrayAgg,
	pgAvg,
	pgCeil,
	pgConcat,
	pgCoalesce,
	pgCount,
	pgDateAdd,
	pgDateDiff,
	pgDatePart,
	pgDateTrunc,
	pgFloor,
	pgGreatest,
	pgIf,
	pgJsonAgg,
	pgJsonContains,
	pgJsonGet,
	pgJsonGetText,
	pgJsonHasKey,
	pgJsonTypeof,
	pgLeast,
	pgLength,
	pgLower,
	pgLtrim,
	pgMax,
	pgMin,
	pgNow,
	pgNullif,
	pgReplace,
	pgRound,
	pgRtrim,
	pgStringAgg,
	pgStrpos,
	pgSubstring,
	pgSum,
	pgToday,
	pgTrim,
	pgUpper
} from "./builtins.pg";
import {
	DATE_ADD_UNITS,
	DATE_DIFF_UNITS,
	DATE_PART_UNITS,
	DATE_TRUNC_UNITS
} from "./date-units";
import { createRegistry, type FunctionEntry, type FunctionRegistry } from "./registry";

const BUILTINS: readonly FunctionEntry[] = [
	{
		name: "upper",
		kind: "scalar",
		arity: { min: 1, max: 1 },
		args: ["string"],
		writeNullBehavior: "propagate",
		engines: { postgres: pgUpper, mongodb: mongoUpper }
	},
	{
		name: "lower",
		kind: "scalar",
		arity: { min: 1, max: 1 },
		args: ["string"],
		writeNullBehavior: "propagate",
		engines: { postgres: pgLower, mongodb: mongoLower }
	},
	{
		name: "length",
		kind: "scalar",
		arity: { min: 1, max: 1 },
		args: ["string"],
		writeNullBehavior: "propagate",
		engines: { postgres: pgLength, mongodb: mongoLength }
	},
	{
		name: "abs",
		kind: "scalar",
		arity: { min: 1, max: 1 },
		args: ["number"],
		writeNullBehavior: "propagate",
		engines: { postgres: pgAbs, mongodb: mongoAbs }
	},
	{
		name: "round",
		kind: "scalar",
		arity: { min: 1, max: 2 },
		args: ["number", "number"],
		writeNullBehavior: "propagate",
		engines: { postgres: pgRound, mongodb: mongoRound }
	},
	{
		name: "coalesce",
		kind: "scalar",
		arity: { min: 2, max: null },
		// Args non typés — `coalesce(x, "default")` mixe types intentionnellement.
		// Sémantique NULL "custom" : renvoie null ssi TOUS args null (pas absorb pur).
		writeNullBehavior: "custom",
		// Sprint T2/6 : kvCoalesce ajouté pour débloquer scalar-around-agg côté KV
		// (`coalesce(sum(x), 0)`). Migration inline → registre.
		engines: { postgres: pgCoalesce, mongodb: mongoCoalesce, kv: kvCoalesce }
	},
	{
		name: "now",
		kind: "scalar",
		arity: { min: 0, max: 0 },
		writeNullBehavior: "deterministic",
		engines: { postgres: pgNow, mongodb: mongoNow }
	},
	{
		name: "concat",
		kind: "scalar",
		arity: { min: 1, max: null },
		// Args non typés — PG `CONCAT` accepte tout et castre en string.
		// writeNullBehavior VOLONTAIREMENT NON DÉCLARÉ : PG concat absorb NULL comme '',
		// Mongo $concat propagate. Divergence NULL irréductible sans concat_strict /
		// concat_ws distincts — reporté sprint 4. Reste refusé en write context.
		engines: { postgres: pgConcat, mongodb: mongoConcat }
	},

	// ─── sprint 3 : string ────────────────────────────────────────────────
	{
		name: "trim",
		kind: "scalar",
		arity: { min: 1, max: 2 },
		args: ["string", "string"],
		writeNullBehavior: "propagate",
		engines: { postgres: pgTrim, mongodb: mongoTrim }
	},
	{
		name: "ltrim",
		kind: "scalar",
		arity: { min: 1, max: 2 },
		args: ["string", "string"],
		writeNullBehavior: "propagate",
		engines: { postgres: pgLtrim, mongodb: mongoLtrim }
	},
	{
		name: "rtrim",
		kind: "scalar",
		arity: { min: 1, max: 2 },
		args: ["string", "string"],
		writeNullBehavior: "propagate",
		engines: { postgres: pgRtrim, mongodb: mongoRtrim }
	},
	{
		name: "substring",
		kind: "scalar",
		arity: { min: 3, max: 3 },
		args: ["string", "number", "number"],
		writeNullBehavior: "propagate",
		engines: { postgres: pgSubstring, mongodb: mongoSubstring }
	},
	{
		name: "replace",
		kind: "scalar",
		arity: { min: 3, max: 3 },
		args: ["string", "string", "string"],
		writeNullBehavior: "propagate",
		engines: { postgres: pgReplace, mongodb: mongoReplace }
	},
	{
		name: "strpos",
		kind: "scalar",
		arity: { min: 2, max: 2 },
		args: ["string", "string"],
		writeNullBehavior: "propagate",
		engines: { postgres: pgStrpos, mongodb: mongoStrpos }
	},

	// ─── sprint 3 : number ────────────────────────────────────────────────
	{
		name: "floor",
		kind: "scalar",
		arity: { min: 1, max: 1 },
		args: ["number"],
		writeNullBehavior: "propagate",
		engines: { postgres: pgFloor, mongodb: mongoFloor }
	},
	{
		name: "ceil",
		kind: "scalar",
		arity: { min: 1, max: 1 },
		args: ["number"],
		writeNullBehavior: "propagate",
		engines: { postgres: pgCeil, mongodb: mongoCeil }
	},

	// ─── sprint 3 : date ──────────────────────────────────────────────────
	{
		name: "today",
		kind: "scalar",
		arity: { min: 0, max: 0 },
		writeNullBehavior: "deterministic",
		engines: { postgres: pgToday, mongodb: mongoToday }
	},
	{
		name: "date_part",
		kind: "scalar",
		arity: { min: 2, max: 2 },
		args: ["string", "date"],
		argEnum: [[...DATE_PART_UNITS], undefined],
		writeNullBehavior: "propagate",
		engines: { postgres: pgDatePart, mongodb: mongoDatePart }
	},
	{
		name: "date_trunc",
		kind: "scalar",
		arity: { min: 2, max: 2 },
		args: ["string", "date"],
		argEnum: [[...DATE_TRUNC_UNITS], undefined],
		writeNullBehavior: "propagate",
		engines: { postgres: pgDateTrunc, mongodb: mongoDateTrunc }
	},
	{
		name: "date_add",
		kind: "scalar",
		arity: { min: 3, max: 3 },
		args: ["string", "date", "number"],
		argEnum: [[...DATE_ADD_UNITS], undefined, undefined],
		writeNullBehavior: "propagate",
		engines: { postgres: pgDateAdd, mongodb: mongoDateAdd }
	},
	{
		name: "date_diff",
		kind: "scalar",
		arity: { min: 3, max: 3 },
		args: ["string", "date", "date"],
		argEnum: [[...DATE_DIFF_UNITS], undefined, undefined],
		writeNullBehavior: "propagate",
		engines: { postgres: pgDateDiff, mongodb: mongoDateDiff }
	},

	// ─── sprint 3 : reserved (sprint 4) ───────────────────────────────────
	{
		name: "regex_replace",
		kind: "reserved",
		arity: { min: 0, max: null },
		engines: {}
	},

	// ─── sprint 4 : JSON (read-only) ──────────────────────────────────────
	{
		name: "json_get",
		kind: "scalar",
		arity: { min: 2, max: null },
		// Path segments = literals string/int — validation dédiée au lower (pas argEnum).
		writeNullBehavior: "propagate",
		mongoMatchHoist: { toPath: extractStaticDotPath, kind: "value" },
		engines: { postgres: pgJsonGet, mongodb: mongoJsonGet }
	},
	{
		name: "json_get_text",
		kind: "scalar",
		arity: { min: 2, max: null },
		writeNullBehavior: "propagate",
		// PAS de mongoMatchHoist v1 : coercion type sans schema introspection
		// risquerait `field int32 42 != string "42"` silencieux cross-engine.
		// Fallback $expr avec $toString explicite. Type-aware hoist reporté sprint 5+.
		engines: { postgres: pgJsonGetText, mongodb: mongoJsonGetText }
	},
	{
		name: "json_has_key",
		kind: "scalar",
		arity: { min: 2, max: 2 },
		writeNullBehavior: "propagate",
		mongoMatchHoist: { toPath: extractStaticDotPath, kind: "exists" },
		engines: { postgres: pgJsonHasKey, mongodb: mongoJsonHasKey }
	},
	{
		name: "json_typeof",
		kind: "scalar",
		arity: { min: 1, max: 1 },
		writeNullBehavior: "propagate",
		engines: { postgres: pgJsonTypeof, mongodb: mongoJsonTypeof }
	},

	// ─── sprint object-literals : json_contains débloqué PG only ──────────
	{
		name: "json_contains",
		kind: "scalar",
		arity: { min: 2, max: 2 },
		// args non typés : subdoc peut être object/array literal, doc column jsonb.
		writeNullBehavior: "propagate",
		// Pas de mongoMatchHoist : Mongo n'a pas d'opérateur @> natif, l'émulation
		// via $expr $mergeObjects est coûteuse et incomplète (subset arrays).
		// Reporté sprint 6+ ; côté Mongo, forEngine renvoie no renderer →
		// planner_unsupported_function avec message actionnable.
		engines: { postgres: pgJsonContains }
	},

	// ─── sprint T2/5 : conditional ────────────────────────────────────────
	// writeNullBehavior 'custom' pour les 4 : NULL cond ≠ NULL result (if/case
	// choisissent la else branch, greatest/least NULL-absorb parité PG, nullif
	// retourne null ssi égalité). Validé par l'utilisateur — pas 'propagate'
	// uniforme qui serait incorrect sémantiquement pour if.
	{
		name: "if",
		kind: "scalar",
		arity: { min: 3, max: 3 },
		// args non typés : cond bool (garde lower_if_cond_type), then/else
		// homogènes (garde lower_if_branches_type_mismatch).
		writeNullBehavior: "custom",
		engines: { postgres: pgIf, mongodb: mongoIf, kv: kvIf }
	},
	{
		name: "nullif",
		kind: "scalar",
		arity: { min: 2, max: 2 },
		writeNullBehavior: "custom",
		engines: { postgres: pgNullif, mongodb: mongoNullif, kv: kvNullif }
	},
	{
		name: "greatest",
		kind: "scalar",
		arity: { min: 2, max: null },
		writeNullBehavior: "custom",
		engines: {
			postgres: pgGreatest,
			mongodb: mongoGreatest,
			kv: kvGreatest
		}
	},
	{
		name: "least",
		kind: "scalar",
		arity: { min: 2, max: null },
		writeNullBehavior: "custom",
		engines: { postgres: pgLeast, mongodb: mongoLeast, kv: kvLeast }
	},

	// ─── sprint T2/6 : aggregates scalaires ───────────────────────────────
	// `writeNullBehavior` VOLONTAIREMENT undefined : les aggregates n'ont
	// aucun sens en contexte write (`update t set y = count(*)`). Refus
	// spécifique lower_agg_in_set (ordre CRITIQUE avant assertNoCallInWrite
	// pour émettre le message précis, pas lower_call_null_write générique).
	// `mongoMatchHoist` undefined : agg jamais dans $match (refus walker
	// lower_agg_in_where en amont).
	//
	// arity :
	//  - count : {min:0,max:1} — 0 args = star (validation guard star_only_count
	//    au parser refuse count() nu sans star ; ici arity accepte 0-1)
	//  - sum/avg : {min:1,max:1} args:['number'] — le typing opt-in fire sur
	//    literal NULL/string, laisse passer field ref (checkable au runtime)
	//  - min/max : {min:1,max:1} args:['any'] — passthrough type
	{
		name: "count",
		kind: "aggregate",
		arity: { min: 0, max: 1 },
		engines: { postgres: pgCount, mongodb: mongoCount, kv: kvCount }
	},
	{
		name: "sum",
		kind: "aggregate",
		arity: { min: 1, max: 1 },
		args: ["number"],
		engines: { postgres: pgSum, mongodb: mongoSum, kv: kvSum }
	},
	{
		name: "avg",
		kind: "aggregate",
		arity: { min: 1, max: 1 },
		args: ["number"],
		engines: { postgres: pgAvg, mongodb: mongoAvg, kv: kvAvg }
	},
	{
		name: "min",
		kind: "aggregate",
		arity: { min: 1, max: 1 },
		engines: { postgres: pgMin, mongodb: mongoMin, kv: kvMin }
	},
	{
		name: "max",
		kind: "aggregate",
		arity: { min: 1, max: 1 },
		engines: { postgres: pgMax, mongodb: mongoMax, kv: kvMax }
	},

	// ─── sprint T2/8 : aggregateMulti (array/string/json_agg) ─────────────
	// Retour = collection (array/string/json). Accepte `sort <keys>` intra-call
	// (parser contextuel via registry.kind === 'aggregateMulti'). Modifier
	// `unique` OK (dedup). NULL parity : array/json inclut, string skip.
	{
		name: "array_agg",
		kind: "aggregateMulti",
		arity: { min: 1, max: 1 },
		engines: {
			postgres: pgArrayAgg,
			mongodb: mongoArrayAgg,
			kv: kvArrayAgg
		}
	},
	{
		name: "string_agg",
		kind: "aggregateMulti",
		arity: { min: 2, max: 2 },
		// args[0] = expression à convertir en text ; args[1] = separator literal.
		args: ["any", "string"],
		engines: {
			postgres: pgStringAgg,
			mongodb: mongoStringAgg,
			kv: kvStringAgg
		}
	},
	{
		name: "json_agg",
		kind: "aggregateMulti",
		arity: { min: 1, max: 1 },
		engines: {
			postgres: pgJsonAgg,
			mongodb: mongoJsonAgg,
			kv: kvJsonAgg
		}
	},

	// ─── sprint 4 : reserved (sprint 5+) ──────────────────────────────────
	{
		name: "json_set",
		kind: "reserved",
		arity: { min: 0, max: null },
		engines: {}
	},
	{
		name: "json_delete",
		kind: "reserved",
		arity: { min: 0, max: null },
		engines: {}
	},
	{
		name: "json_merge",
		kind: "reserved",
		arity: { min: 0, max: null },
		engines: {}
	},
	{
		name: "json_path",
		kind: "reserved",
		arity: { min: 0, max: null },
		engines: {}
	},
	{
		name: "json_array_length",
		kind: "reserved",
		arity: { min: 0, max: null },
		engines: {}
	},
	{
		name: "json_length",
		kind: "reserved",
		arity: { min: 0, max: null },
		engines: {}
	},
	{
		name: "json_object_keys",
		kind: "reserved",
		arity: { min: 0, max: null },
		engines: {}
	}
];

/** Registre par défaut — exhaustive pour PG et Mongo, prêt à l'emploi. */
export const SNQL_FUNCTIONS: FunctionRegistry = createRegistry(BUILTINS);
