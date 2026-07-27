import type { Mapper, NativeQuery } from "./codegen/mapper";
import { mongoMapper } from "./codegen/mongodb";
import { postgresMapper } from "./codegen/postgres";
import { SnqlError } from "./diagnostics";
import { lower } from "./ir/lower";
import type { LogicalPlan } from "./ir/plan";
import { tokenize } from "./lexer/lexer";
import type { Query } from "./parser/ast";
import { parse } from "./parser/parser";
import { capabilitiesFor } from "./planner/capabilities";
import type { PhysicalPlan, PlanOptions } from "./planner/planner";
import { plan } from "./planner/planner";

export type SupportedEngine = "postgres" | "mongodb";

export interface CompileOptions {
	readonly engine: SupportedEngine;
}

export interface CompileResult {
	readonly query: Query;
	readonly plan: LogicalPlan;
	readonly native: NativeQuery;
}

const MAPPERS: Readonly<Record<SupportedEngine, Mapper>> = {
	postgres: postgresMapper,
	mongodb: mongoMapper
};

export function getMapper(engine: SupportedEngine): Mapper {
	return MAPPERS[engine];
}

/**
 * Compile une requête SNQL vers la requête native d'un moteur.
 * Pipeline : tokenize → parse → lower (IR) → mapper (codegen). Pur, sans I/O.
 */
export function compile(
	source: string,
	options: CompileOptions
): CompileResult {
	const query = parse(tokenize(source));
	const logicalPlan = lower(query);
	const native = getMapper(options.engine).map(logicalPlan);
	return { query, plan: logicalPlan, native };
}

/**
 * Compile puis découpe pour un moteur : tokenize → parse → lower → planner.
 * Retourne le plan physique (pushdown poussé nativement + compensation en runtime).
 */
export function planFor(
	source: string,
	engine: string,
	options: PlanOptions = {}
): PhysicalPlan {
	const capabilities = capabilitiesFor(engine);
	if (capabilities === undefined) {
		throw new SnqlError(`Moteur inconnu '${engine}'`, "unknown_engine");
	}
	return plan(lower(parse(tokenize(source))), capabilities, options);
}

export type {
	Mapper,
	MongoQuery,
	MongoStage,
	NativeQuery,
	SqlQuery
} from "./codegen/mapper";
export { SnqlError } from "./diagnostics";
export { lower } from "./ir/lower";
export type {
	Capability,
	CompareOp,
	LogicalPlan,
	PlanExpr,
	PlanProjectField,
	PlanSortKey,
	SqlValue
} from "./ir/plan";
export type { OperationKind } from "./lexer/dictionary";
// --- API publique bas niveau (chaque étage du pipeline) ---
export { tokenize } from "./lexer/lexer";
// --- Types publics ---
export type { Position, Span, Token, TokenKind } from "./lexer/token";
export type {
	CompareOperator,
	Expr,
	FieldSelection,
	LiteralValue,
	Query,
	SortKey,
	Source,
	Stage
} from "./parser/ast";
export { parse } from "./parser/parser";
export type { Capabilities } from "./planner/capabilities";
export {
	capabilitiesFor,
	KV_CAPABILITIES,
	MONGODB_CAPABILITIES,
	POSTGRES_CAPABILITIES,
	supports
} from "./planner/capabilities";
export type {
	CompensationOp,
	PhysicalPlan,
	PlanOptions
} from "./planner/planner";
export { plan } from "./planner/planner";
export type { JoinSources, Row } from "./runtime/compensate";
export { compensate } from "./runtime/compensate";
