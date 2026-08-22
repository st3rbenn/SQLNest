/**
 * Walker AST qui remonte les patterns SNQL non-indexables côté Mongo (perf
 * warnings). Complémentaire à `divergenceHints.ts` qui remonte les
 * divergences sémantiques : ici on cible la perf, pas la correction.
 * Signalé au user via squiggly INFO + tooltip préfixé "⚡ perf:".
 *
 * Le hook `useLiveDiagnostics` chaîne divergenceHints (prio 1) puis perfHints
 * (prio 2) — l'info correction prévaut sur l'info perf, mais les deux sont
 * émises en severity: "info" (canal unique squiggly bleu discret).
 *
 * Patterns détectés (Mongo only) :
 *  - `cast(_)` dans le predicate d'un `update`/`remove` → codegen Mongo
 *    route via pipeline update `$expr + $convert` qui est non-indexable
 *    (sauf aggregation index Mongo 6.0+ rarement configuré).
 *  - correlated subquery (`exists/in (find X where X.col = Y.col)`) →
 *    codegen Mongo lift en `$lookup{let, pipeline}` qui exécute un scan
 *    par row outer (indexé sur foreign side seulement si la key l'est).
 */

import type {
	Expr,
	InsertStatement,
	LetStatement,
	Query,
	SavepointStatement,
	Stage,
	Statement,
	TransactionStatement,
	UpdateStatement
} from "@sqlnest/snql";
import type { SerializedSpan } from "./useRunQuery";

type DeleteStatement = Extract<Statement, { operation: "delete" }>;

export interface PerfHint {
	readonly span: SerializedSpan;
	readonly code: string;
	readonly message: string;
}

/** Walk le statement et retourne tous les hints perf Mongo trouvés. */
export function collectPerfHints(statement: Statement): readonly PerfHint[] {
	const hints: PerfHint[] = [];
	walkStatement(statement, hints, /*insideWritePredicate*/ false);
	return hints;
}

function walkStatement(
	statement: Statement,
	out: PerfHint[],
	insideWritePredicate: boolean
): void {
	switch (statement.operation) {
		case "select":
			walkQuery(statement, out);
			return;
		case "insert":
			walkInsert(statement, out);
			return;
		case "update":
			walkUpdate(statement, out);
			return;
		case "delete":
			walkDelete(statement, out);
			return;
		case "transaction":
			walkTransaction(statement, out);
			return;
		case "let":
			walkLet(statement, out);
			return;
		case "savepoint":
			walkSavepoint(statement, out);
			return;
		case "raw":
		case "introspect":
			return;
	}
	void insideWritePredicate;
}

function walkQuery(query: Query, out: PerfHint[]): void {
	for (const stage of query.stages) walkStage(stage, out, query);
}

function walkStage(stage: Stage, out: PerfHint[], query: Query): void {
	switch (stage.type) {
		case "where":
		case "having":
			// Correlated subquery dans un where
			walkExpr(stage.predicate, out, query, false);
			return;
		case "pick":
			for (const f of stage.fields) {
				if (f.expr !== undefined) walkExpr(f.expr, out, query, false);
			}
			return;
		case "group":
		case "sort":
		case "limit":
		case "with":
			return;
	}
}

function walkInsert(stmt: InsertStatement, out: PerfHint[]): void {
	for (const row of stmt.rows) {
		for (const cell of row.fields) walkExpr(cell.value, out, undefined, false);
	}
	if (stmt.sourceQuery !== undefined) walkQuery(stmt.sourceQuery, out);
}

function walkUpdate(stmt: UpdateStatement, out: PerfHint[]): void {
	for (const a of stmt.assignments) walkExpr(a.value, out, undefined, false);
	// Cast dans predicate write → hint perf
	if (stmt.predicate !== undefined) {
		walkExpr(stmt.predicate, out, undefined, /*insideWritePredicate*/ true);
	}
}

function walkDelete(stmt: DeleteStatement, out: PerfHint[]): void {
	if (stmt.predicate !== undefined) {
		walkExpr(stmt.predicate, out, undefined, /*insideWritePredicate*/ true);
	}
}

function walkTransaction(stmt: TransactionStatement, out: PerfHint[]): void {
	for (const item of stmt.body) {
		if (item.operation === "savepoint") walkSavepoint(item, out);
		else walkStatement(item as Statement, out, false);
	}
}

function walkLet(stmt: LetStatement, out: PerfHint[]): void {
	for (const b of stmt.bindings) walkQuery(b.query, out);
	walkStatement(stmt.body as unknown as Statement, out, false);
}

function walkSavepoint(stmt: SavepointStatement, out: PerfHint[]): void {
	for (const item of stmt.body) walkStatement(item as Statement, out, false);
}

/**
 * `outerQuery` porte la Query dans laquelle cette Expr vit ; sert à détecter
 * les correlated subqueries (compare une ref field de la sub-find avec les
 * alias déclarés dans l'outer).
 */
function walkExpr(
	expr: Expr,
	out: PerfHint[],
	outerQuery: Query | undefined,
	insideWritePredicate: boolean
): void {
	switch (expr.type) {
		case "cast":
			if (insideWritePredicate) {
				// Cast dans predicate write → $expr+$convert non-indexable
				emitCastInWritePredicate(expr, out);
			}
			walkExpr(expr.operand, out, outerQuery, insideWritePredicate);
			return;
		case "exists":
			if ("subquery" in expr && expr.subquery.type === "subquery") {
				checkCorrelated(expr.subquery.query, outerQuery, expr.span, out);
				walkQuery(expr.subquery.query, out);
			}
			return;
		case "subquery":
			checkCorrelated(expr.query, outerQuery, expr.span, out);
			walkQuery(expr.query, out);
			return;
		case "compare":
		case "logical":
		case "arith":
			walkExpr(expr.left, out, outerQuery, insideWritePredicate);
			walkExpr(expr.right, out, outerQuery, insideWritePredicate);
			return;
		case "not":
			walkExpr(expr.operand, out, outerQuery, insideWritePredicate);
			return;
		case "in":
			walkExpr(expr.target, out, outerQuery, insideWritePredicate);
			for (const v of expr.values) {
				walkExpr(v, out, outerQuery, insideWritePredicate);
			}
			return;
		case "call":
			for (const a of expr.args) {
				walkExpr(a, out, outerQuery, insideWritePredicate);
			}
			return;
		case "isNull":
			walkExpr(expr.operand, out, outerQuery, insideWritePredicate);
			return;
		case "case":
			for (const b of expr.branches) {
				walkExpr(b.cond, out, outerQuery, insideWritePredicate);
				walkExpr(b.value, out, outerQuery, insideWritePredicate);
			}
			walkExpr(expr.elseValue, out, outerQuery, insideWritePredicate);
			return;
		case "object":
			for (const e of expr.entries) {
				walkExpr(e.value, out, outerQuery, insideWritePredicate);
			}
			return;
		case "array":
			for (const i of expr.items) {
				walkExpr(i, out, outerQuery, insideWritePredicate);
			}
			return;
		case "literal":
		case "field":
		case "windowCall":
		case "upsertNew":
			return;
	}
}

function emitCastInWritePredicate(
	cast: Expr & { type: "cast" },
	out: PerfHint[]
): void {
	out.push({
		span: [cast.span.start.offset, cast.span.end.offset - cast.span.start.offset],
		code: "planner_mongo_perf_non_indexable_cast_write",
		message:
			"⚡ perf : cast dans un where write Mongo → pipeline update `$expr+$convert` non-indexable (scan collection). Refactor : matérialise le filtre côté application, ou stocke la valeur convertie en champ dédié pour indexer dessus."
	});
}

function checkCorrelated(
	subQuery: Query,
	outerQuery: Query | undefined,
	span: { start: { offset: number }; end: { offset: number } },
	out: PerfHint[]
): void {
	if (outerQuery === undefined) return;
	const outerAliases = collectAliases(outerQuery);
	const subLocalAlias = subQuery.source.alias ?? subQuery.source.collection;
	// Est-ce que la sub-query référence un des alias outer ?
	let hasCorrelation = false;
	const walk = (e: Expr): void => {
		if (hasCorrelation) return;
		switch (e.type) {
			case "field":
				if (e.path.length > 1) {
					const head = e.path[0]!;
					if (head !== subLocalAlias && outerAliases.has(head)) {
						hasCorrelation = true;
					}
				}
				return;
			case "compare":
			case "logical":
			case "arith":
				walk(e.left);
				walk(e.right);
				return;
			case "not":
			case "isNull":
			case "cast":
				walk(e.operand);
				return;
			case "in":
				walk(e.target);
				for (const v of e.values) walk(v);
				return;
			case "call":
				for (const a of e.args) walk(a);
				return;
			case "case":
				for (const b of e.branches) {
					walk(b.cond);
					walk(b.value);
				}
				walk(e.elseValue);
				return;
			case "object":
				for (const en of e.entries) walk(en.value);
				return;
			case "array":
				for (const i of e.items) walk(i);
				return;
			case "subquery":
			case "exists":
			case "literal":
			case "windowCall":
			case "upsertNew":
				return;
		}
	};
	for (const stage of subQuery.stages) {
		if (stage.type === "where" || stage.type === "having") walk(stage.predicate);
		else if (stage.type === "pick") {
			for (const f of stage.fields) if (f.expr !== undefined) walk(f.expr);
		}
	}
	if (hasCorrelation) {
		out.push({
			span: [span.start.offset, span.end.offset - span.start.offset],
			code: "planner_mongo_perf_non_indexable_correlated",
			message:
				"⚡ perf : correlated subquery Mongo → `$lookup{let, pipeline}` non-indexable (scan per outer row). Refactor : matérialise via `let` + join réel si la key est indexée, ou attends l'aggregation index Mongo 6.0+ sur la foreign key."
		});
	}
}

function collectAliases(query: Query): Set<string> {
	const aliases = new Set<string>();
	if (query.source.alias !== undefined) aliases.add(query.source.alias);
	for (const stage of query.stages) {
		if (stage.type === "with" && stage.alias !== undefined) {
			aliases.add(stage.alias);
		}
	}
	return aliases;
}
