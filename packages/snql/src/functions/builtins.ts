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

import {
	mongoAbs,
	mongoCeil,
	mongoConcat,
	mongoCoalesce,
	mongoDateAdd,
	mongoDateDiff,
	mongoDatePart,
	mongoDateTrunc,
	mongoFloor,
	mongoLength,
	mongoLower,
	mongoLtrim,
	mongoNow,
	mongoReplace,
	mongoRound,
	mongoRtrim,
	mongoStrpos,
	mongoSubstring,
	mongoToday,
	mongoTrim,
	mongoUpper
} from "./builtins.mongo";
import {
	pgAbs,
	pgCeil,
	pgConcat,
	pgCoalesce,
	pgDateAdd,
	pgDateDiff,
	pgDatePart,
	pgDateTrunc,
	pgFloor,
	pgLength,
	pgLower,
	pgLtrim,
	pgNow,
	pgReplace,
	pgRound,
	pgRtrim,
	pgStrpos,
	pgSubstring,
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
		engines: { postgres: pgCoalesce, mongodb: mongoCoalesce }
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
	}
];

/** Registre par défaut — exhaustive pour PG et Mongo, prêt à l'emploi. */
export const SNQL_FUNCTIONS: FunctionRegistry = createRegistry(BUILTINS);
