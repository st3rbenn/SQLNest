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
import type { SchemaModel } from "./schema/model";

export type SupportedEngine = "postgres" | "mongodb";

export interface CompileOptions {
	readonly engine: SupportedEngine;
	/**
	 * Schéma introspecté — utilisé par le lower pour inférer la multiplicité des
	 * joins `with` (many-to-one → LEFT JOIN, one-to-many → embed array). Absent
	 * = tous les joins retombent en `embed` (comportement historique).
	 */
	readonly schema?: SchemaModel;
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
	const statement = parse(tokenize(source));
	if (statement.operation !== "select") {
		throw new SnqlError(
			`compile() est en lecture seule ; '${statement.operation}' est une mutation.`,
			"compile_read_only"
		);
	}
	const logicalPlan = lower(statement, options.schema);
	const native = getMapper(options.engine).map(logicalPlan);
	return { query: statement, plan: logicalPlan, native };
}

/**
 * Compile puis découpe pour un moteur : tokenize → parse → lower → planner.
 * Retourne le plan physique (pushdown poussé nativement + compensation en runtime).
 * `schema` est optionnel — voir [[CompileOptions]] pour l'usage.
 */
export function planFor(
	source: string,
	engine: string,
	options: PlanOptions & { readonly schema?: SchemaModel } = {}
): PhysicalPlan {
	const capabilities = capabilitiesFor(engine);
	if (capabilities === undefined) {
		throw new SnqlError(`Moteur inconnu '${engine}'`, "unknown_engine");
	}
	const statement = parse(tokenize(source));
	if (statement.operation !== "select") {
		throw new SnqlError(
			`planFor() est en lecture seule ; '${statement.operation}' est une mutation.`,
			"plan_read_only"
		);
	}
	return plan(lower(statement, options.schema), capabilities, options);
}

export type {
	Mapper,
	MapperContext,
	MongoIntrospectQuery,
	MongoQuery,
	MongoStage,
	MongoWriteQuery,
	NativeQuery,
	SerializedSpan,
	SqlQuery,
	SqlTransaction,
	SqlTransactionStep
} from "./codegen/mapper";
export { SnqlError } from "./diagnostics";
export {
	lower,
	lowerIntrospect,
	lowerLet,
	lowerMutation,
	lowerRaw,
	lowerTransaction
} from "./ir/lower";
export type {
	Capability,
	CompareOp,
	IntrospectPlan,
	LogicalPlan,
	MutationPlan,
	Plan,
	PlanColumnValue,
	PlanExpr,
	PlanProjectField,
	PlanSortKey,
	SqlDecimal,
	SqlValue
} from "./ir/plan";
export { isSqlDecimal } from "./ir/plan";
// --- Language service (éditeur : complétion schema-aware) ---
export type {
	SnqlCompletion,
	SnqlCompletionResult,
	SnqlCompletionType
} from "./language/complete";
export { completeSnql } from "./language/complete";
export { formatSnql } from "./language/format";
export {
	collectIdentSpans,
	type IdentSpans
} from "./language/ident-spans";
export type { OperationKind } from "./lexer/dictionary";
// Token Dictionary : source de vérité du vocabulaire de surface, exposée pour
// l'outillage éditeur (coloration/complétion) — pas de redéfinition côté front.
export { INTROSPECT_VERBS, KEYWORDS, verbOperation } from "./lexer/dictionary";
// --- API publique bas niveau (chaque étage du pipeline) ---
export { tokenize } from "./lexer/lexer";
// --- Types publics ---
export type { Position, Span, Token, TokenKind } from "./lexer/token";
export type {
	Assignment,
	CastTarget,
	CompareOperator,
	DeleteStatement,
	Expr,
	FieldSelection,
	InsertField,
	InsertRow,
	InsertStatement,
	IntrospectKind,
	IntrospectStatement,
	IsolationLevel,
	LiteralValue,
	Query,
	SavepointStatement,
	SortKey,
	Source,
	Stage,
	Statement,
	TransactionBodyItem,
	TransactionStatement,
	UpdateStatement
} from "./parser/ast";
export { CAST_TARGETS } from "./parser/ast";
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
export {
	assertIntrospectSupported,
	assertLetSupported,
	assertMutationCastTargetsSupported,
	assertMutationInsertSelectSupported,
	assertMutationUpsertSupported,
	assertMutationWriteJoinSupported,
	assertTransactionSupported,
	plan
} from "./planner/planner";
export type { JoinSources, Row } from "./runtime/compensate";
export { compensate } from "./runtime/compensate";
export { inferResultColumns } from "./runtime/infer-column-types";
export type { ResultColumn, ResultSet } from "./runtime/result";
export type {
	Collection,
	Field,
	FieldRef,
	Relation,
	RelationKind,
	RelationOrigin,
	SchemaModel,
	SchemaSource,
	SnqlType
} from "./schema/model";
