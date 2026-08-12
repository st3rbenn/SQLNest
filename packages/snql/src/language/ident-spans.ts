/**
 * Collecte tous les spans source de chaque identifiant (nom de collection,
 * colonne, alias, segment de path) dans un `Statement` SNQL — indexés par
 * nom d'ident.
 *
 * Utilisé pour résoudre les erreurs Postgres qui pointent un ident par nom :
 *
 *   - `column "foo" does not exist`  →  `identSpans["foo"]` → surligne toutes
 *     les occurrences dans l'éditeur.
 *   - `relation "bar" does not exist` → idem pour `bar`.
 *
 * Compromis vs un vrai source-map SQL→SNQL byte-offset :
 * - Pas de refactor du codegen (aucun risque de casser la sortie exacte du SQL).
 * - Ambigu si le même nom apparaît plusieurs fois (col utilisée en WHERE +
 *   pick, ou self-join) : on surligne toutes les occurrences — l'utilisateur
 *   voit le champ concerné sans devoir chercher.
 * - Ne couvre pas `LINE N position M` (erreurs syntaxe pg) — cas rare, différé.
 */

import type { SerializedSpan } from "../codegen/mapper";
import type {
	DeleteStatement,
	Expr,
	InsertStatement,
	Query,
	Stage,
	Statement,
	UpdateStatement
} from "../parser/ast";
import type { Span } from "../lexer/token";

/**
 * Map des spans par nom d'ident. Chaque nom → liste de spans (triés dans
 * l'ordre d'apparition dans le source). Ne contient QUE les idents qu'un
 * moteur SQL pourrait mentionner par nom dans une erreur : noms de
 * collection, colonnes, alias, segments de path.
 *
 * Compact : `SerializedSpan` = `[start, length]` — dérivable en `line/column`
 * côté frontend depuis la source SNQL en cours.
 */
export type IdentSpans = Record<string, readonly SerializedSpan[]>;

function ser(span: Span): SerializedSpan {
	return [span.start.offset, span.end.offset - span.start.offset];
}

/**
 * Collecte tous les identifiants d'un statement SNQL avec leurs spans source.
 * Retourne un objet plat `{ nom: [span, ...] }` — jamais `null`, jamais
 * `undefined`, jamais d'entrée vide.
 *
 * Note : les paths pointés (`r.upi`) contribuent chaque segment sous SON
 * propre nom (ici `r` et `upi`), le span étant celui du path entier (l'AST
 * n'a pas de span par segment). Une pg-error `column "upi"` matchera donc
 * le path complet — acceptable pour un highlight, pas exact.
 */
export function collectIdentSpans(statement: Statement): IdentSpans {
	const out: Record<string, SerializedSpan[]> = {};

	function push(name: string, span: Span | undefined): void {
		if (name === "" || span === undefined) return;
		(out[name] ??= []).push(ser(span));
	}

	// Émet chaque segment d'un path (`r.upi` → deux entrées `r`+`upi`) sous
	// le span global du path (l'AST n'a pas de span par segment).
	function pushPath(path: readonly string[], span: Span | undefined): void {
		for (const seg of path) push(seg, span);
	}

	function walkExpr(expr: Expr): void {
		switch (expr.type) {
			case "field":
				pushPath(expr.path, expr.span);
				return;
			case "literal":
				return;
			case "compare":
			case "logical":
				walkExpr(expr.left);
				walkExpr(expr.right);
				return;
			case "not":
				walkExpr(expr.operand);
				return;
			case "in":
				walkExpr(expr.target);
				for (const v of expr.values) walkExpr(v);
				return;
		}
	}

	function walkStage(stage: Stage): void {
		switch (stage.type) {
			case "where":
				walkExpr(stage.predicate);
				return;
			case "pick":
				for (const field of stage.fields) {
					pushPath(field.path, field.span);
					if (field.alias !== undefined) push(field.alias, field.span);
				}
				return;
			case "sort":
				for (const key of stage.keys) pushPath(key.path, key.span);
				return;
			case "with":
				push(stage.collection, stage.span);
				if (stage.alias !== undefined) push(stage.alias, stage.span);
				pushPath(stage.localField, stage.span);
				pushPath(stage.foreignField, stage.span);
				return;
			case "limit":
				return;
		}
	}

	function walkQuery(query: Query): void {
		push(query.source.collection, query.source.span);
		if (query.source.alias !== undefined) push(query.source.alias, query.source.span);
		for (const s of query.stages) walkStage(s);
	}

	function walkInsert(stmt: InsertStatement): void {
		push(stmt.collection, stmt.span);
		for (const row of stmt.rows) {
			for (const field of row.fields) {
				push(field.column, field.span);
				walkExpr(field.value);
			}
		}
	}

	function walkUpdate(stmt: UpdateStatement): void {
		push(stmt.collection, stmt.span);
		for (const a of stmt.assignments) {
			push(a.column, a.span);
			walkExpr(a.value);
		}
		if (stmt.predicate !== undefined) walkExpr(stmt.predicate);
	}

	function walkDelete(stmt: DeleteStatement): void {
		push(stmt.collection, stmt.span);
		if (stmt.predicate !== undefined) walkExpr(stmt.predicate);
	}

	switch (statement.operation) {
		case "select":
			walkQuery(statement);
			break;
		case "insert":
			walkInsert(statement);
			break;
		case "update":
			walkUpdate(statement);
			break;
		case "delete":
			walkDelete(statement);
			break;
	}

	return out as IdentSpans;
}
