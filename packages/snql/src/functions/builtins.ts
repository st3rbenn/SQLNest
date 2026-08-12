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
	mongoConcat,
	mongoCoalesce,
	mongoLength,
	mongoLower,
	mongoNow,
	mongoRound,
	mongoUpper
} from "./builtins.mongo";
import {
	pgAbs,
	pgConcat,
	pgCoalesce,
	pgLength,
	pgLower,
	pgNow,
	pgRound,
	pgUpper
} from "./builtins.pg";
import { createRegistry, type FunctionEntry, type FunctionRegistry } from "./registry";

const BUILTINS: readonly FunctionEntry[] = [
	{
		name: "upper",
		kind: "scalar",
		arity: { min: 1, max: 1 },
		args: ["string"],
		engines: { postgres: pgUpper, mongodb: mongoUpper }
	},
	{
		name: "lower",
		kind: "scalar",
		arity: { min: 1, max: 1 },
		args: ["string"],
		engines: { postgres: pgLower, mongodb: mongoLower }
	},
	{
		name: "length",
		kind: "scalar",
		arity: { min: 1, max: 1 },
		args: ["string"],
		engines: { postgres: pgLength, mongodb: mongoLength }
	},
	{
		name: "abs",
		kind: "scalar",
		arity: { min: 1, max: 1 },
		args: ["number"],
		engines: { postgres: pgAbs, mongodb: mongoAbs }
	},
	{
		name: "round",
		kind: "scalar",
		arity: { min: 1, max: 2 },
		args: ["number", "number"],
		engines: { postgres: pgRound, mongodb: mongoRound }
	},
	{
		name: "coalesce",
		kind: "scalar",
		arity: { min: 2, max: null },
		// Args non typés — `coalesce(x, "default")` mixe types intentionnellement.
		engines: { postgres: pgCoalesce, mongodb: mongoCoalesce }
	},
	{
		name: "now",
		kind: "scalar",
		arity: { min: 0, max: 0 },
		engines: { postgres: pgNow, mongodb: mongoNow }
	},
	{
		name: "concat",
		kind: "scalar",
		arity: { min: 1, max: null },
		// Args non typés — PG `CONCAT` accepte tout et castre en string.
		engines: { postgres: pgConcat, mongodb: mongoConcat }
	}
];

/** Registre par défaut — exhaustive pour PG et Mongo, prêt à l'emploi. */
export const SNQL_FUNCTIONS: FunctionRegistry = createRegistry(BUILTINS);
