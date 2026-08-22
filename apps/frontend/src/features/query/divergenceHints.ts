/**
 * Walker AST qui remonte les patterns SNQL sujets à divergences sémantiques
 * PG↔Mongo (registre `divergences-mongo-vs-pg.ts`). Chaque pattern rencontré
 * produit un `DivergenceHint` avec span source + entrée du registre. Le
 * hook `useLiveDiagnostics` sélectionne le premier hint pour l'émettre en
 * `severity: "info"` (squiggly bleu discret + tooltip).
 *
 * Cross-engine : le hint ne s'affiche que quand l'engine cible est Mongo — sur
 * PG les divergences ne s'appliquent pas (PG est la référence). Le filtrage
 * engine est fait en amont côté hook.
 *
 * Patterns détectés (walker directement sur le AST, pas besoin de plan) :
 *  - `concat(…)` — call name === "concat"
 *  - `json_contains(…)` — call name === "json_contains"
 *  - `cast(_ as bool)` — cast target === "bool"
 *  - `cast(_ as date)` — cast target === "date"
 *  - `!=` — compare operator === "!="
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
import { hintsForConstruct } from "@sqlnest/snql";
type DeleteStatement = Extract<Statement, { operation: "delete" }>;
import type { SerializedSpan } from "./useRunQuery";

export interface DivergenceHint {
	readonly span: SerializedSpan;
	readonly code: string;
	readonly message: string;
}

/**
 * Walk le statement + expressions imbriquées pour extraire tous les patterns
 * divergents. Ordre : préservé source-order (walker DFS avec émission au
 * premier match). Doublons possibles si un même construct apparaît plusieurs
 * fois — le hook n'affiche que le premier.
 */
export function collectDivergenceHints(
	statement: Statement
): readonly DivergenceHint[] {
	const hints: DivergenceHint[] = [];
	walkStatement(statement, hints);
	return hints;
}

function walkStatement(statement: Statement, out: DivergenceHint[]): void {
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
			// Raw = opaque, introspect = pas d'expr user. Rien à walker.
			return;
	}
}

function walkQuery(query: Query, out: DivergenceHint[]): void {
	for (const stage of query.stages) walkStage(stage, out);
}

function walkStage(stage: Stage, out: DivergenceHint[]): void {
	switch (stage.type) {
		case "where":
		case "having":
			walkExpr(stage.predicate, out);
			return;
		case "pick":
			for (const f of stage.fields) {
				if (f.expr !== undefined) walkExpr(f.expr, out);
			}
			return;
		case "group":
		case "sort":
		case "limit":
		case "with":
			return;
	}
}

function walkInsert(stmt: InsertStatement, out: DivergenceHint[]): void {
	for (const row of stmt.rows) {
		for (const cell of row.fields) walkExpr(cell.value, out);
	}
	if (stmt.sourceQuery !== undefined) walkQuery(stmt.sourceQuery, out);
	if (stmt.onConflict !== undefined) {
		if (stmt.onConflict.action.kind === "update") {
			for (const a of stmt.onConflict.action.assignments) walkExpr(a.value, out);
			if (stmt.onConflict.action.where !== undefined)
				walkExpr(stmt.onConflict.action.where, out);
		}
	}
}

function walkUpdate(stmt: UpdateStatement, out: DivergenceHint[]): void {
	for (const a of stmt.assignments) walkExpr(a.value, out);
	if (stmt.predicate !== undefined) walkExpr(stmt.predicate, out);
}

function walkDelete(stmt: DeleteStatement, out: DivergenceHint[]): void {
	if (stmt.predicate !== undefined) walkExpr(stmt.predicate, out);
}

function walkTransaction(stmt: TransactionStatement, out: DivergenceHint[]): void {
	for (const item of stmt.body) {
		if (item.operation === "savepoint") walkSavepoint(item, out);
		else walkStatement(item as Statement, out);
	}
}

function walkLet(stmt: LetStatement, out: DivergenceHint[]): void {
	for (const b of stmt.bindings) walkQuery(b.query, out);
	walkStatement(stmt.body as unknown as Statement, out);
}

function walkSavepoint(stmt: SavepointStatement, out: DivergenceHint[]): void {
	for (const item of stmt.body) walkStatement(item as Statement, out);
}

function walkExpr(expr: Expr, out: DivergenceHint[]): void {
	switch (expr.type) {
		case "call":
			// Constructs surfacés par hintsForConstruct : concat, json_contains.
			emitFor(expr.name, expr.span, out);
			for (const a of expr.args) walkExpr(a, out);
			return;
		case "cast": {
			// Constructs cast(_ as X) — utilise le pattern normalisé du registre.
			const key = `cast(_ as ${expr.target})`;
			emitFor(key, expr.span, out);
			walkExpr(expr.operand, out);
			return;
		}
		case "compare":
			// `!=` sur write context peut data-loss (3VL). MVP émet sur tout compare
			// != (walker context-libre — le hint dit "sur write" dans hintMessage).
			if (expr.operator === "!=") {
				emitFor("!=", expr.span, out);
			}
			walkExpr(expr.left, out);
			walkExpr(expr.right, out);
			return;
		case "logical":
		case "arith":
			walkExpr(expr.left, out);
			walkExpr(expr.right, out);
			return;
		case "not":
			walkExpr(expr.operand, out);
			return;
		case "in":
			walkExpr(expr.target, out);
			for (const v of expr.values) walkExpr(v, out);
			return;
		case "isNull":
			walkExpr(expr.operand, out);
			return;
		case "case":
			for (const b of expr.branches) {
				walkExpr(b.cond, out);
				walkExpr(b.value, out);
			}
			walkExpr(expr.elseValue, out);
			return;
		case "object":
			for (const e of expr.entries) walkExpr(e.value, out);
			return;
		case "array":
			for (const i of expr.items) walkExpr(i, out);
			return;
		case "subquery":
			walkQuery(expr.query, out);
			return;
		case "exists":
			// exists (subquery) — walker le sub-query si présent
			if ("subquery" in expr && expr.subquery.type === "subquery") {
				walkQuery(expr.subquery.query, out);
			}
			return;
		case "literal":
		case "field":
		case "windowCall":
		case "upsertNew":
			return;
	}
}

function emitFor(
	construct: string,
	span: { start: { offset: number }; end: { offset: number } },
	out: DivergenceHint[]
): void {
	const entries = hintsForConstruct(construct);
	if (entries.length === 0) return;
	const first = entries[0]!;
	if (first.hintMessage === undefined) return;
	const serializedSpan: SerializedSpan = [
		span.start.offset,
		span.end.offset - span.start.offset
	];
	out.push({
		span: serializedSpan,
		code: first.code,
		message: first.hintMessage
	});
}
