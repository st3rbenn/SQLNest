import { SnqlError } from "../diagnostics";
import type {
	CompareOperator,
	DeleteStatement,
	Expr,
	FieldSelection,
	LiteralValue,
	Query,
	SortKey,
	Stage,
	UpdateStatement
} from "../parser/ast";
import type {
	CompareOp,
	LogicalPlan,
	MutationPlan,
	PlanExpr,
	PlanProjectField,
	PlanSortKey,
	SqlValue
} from "./plan";

/** Abaisse l'AST de surface en Logical Plan canonique (collapse des synonymes, etc.). */
export function lower(query: Query): LogicalPlan {
	if (query.operation !== "select") {
		throw new SnqlError(
			`Opération '${query.operation}' non supportée en Slice 1`,
			"lower_unsupported_operation"
		);
	}

	let plan: LogicalPlan =
		query.source.alias !== undefined
			? {
					op: "scan",
					collection: query.source.collection,
					alias: query.source.alias
				}
			: { op: "scan", collection: query.source.collection };

	// null = toutes les colonnes disponibles ; après un `pick`, seules celles projetées le restent.
	let available: ReadonlySet<string> | null = null;
	for (const stage of query.stages) {
		checkColumnsAvailable(stage, available);
		plan = lowerStage(plan, stage, query.source.alias);
		if (stage.type === "pick") {
			available = projectionKeys(stage.fields);
		} else if (stage.type === "with" && available !== null) {
			// le join ajoute un champ imbriqué (`as`) aux colonnes disponibles
			available = new Set([...available, stage.alias ?? stage.collection]);
		}
	}
	return plan;
}

/** Abaisse une mutation (update / delete) en [[MutationPlan]]. Réutilise `lowerExpr`. */
export function lowerMutation(
	statement: UpdateStatement | DeleteStatement
): MutationPlan {
	if (statement.operation === "update") {
		assertUniqueAssignments(statement.assignments);
		return {
			op: "update",
			collection: statement.collection,
			assignments: statement.assignments.map((assignment) => ({
				column: assignment.column,
				value: lowerExpr(assignment.value)
			})),
			predicate: lowerExpr(statement.predicate)
		};
	}
	return {
		op: "delete",
		collection: statement.collection,
		predicate: lowerExpr(statement.predicate)
	};
}

/**
 * Une même colonne ne peut être affectée qu'une fois dans un `set` (Postgres
 * rejette `SET x = 1, x = 2`). On lève une erreur claire à la compilation plutôt
 * que de laisser le moteur échouer — cohérent avec le chemin de lecture.
 */
function assertUniqueAssignments(
	assignments: readonly { readonly column: string }[]
): void {
	const seen = new Set<string>();
	for (const assignment of assignments) {
		if (seen.has(assignment.column)) {
			throw new SnqlError(
				`Colonne '${assignment.column}' affectée plusieurs fois dans un 'set'`,
				"lower_duplicate_assignment"
			);
		}
		seen.add(assignment.column);
	}
}

/** Noms de sortie d'un `pick` = alias, sinon dernier segment du chemin. */
function projectionKeys(
	fields: readonly FieldSelection[]
): ReadonlySet<string> {
	return new Set(
		fields.map(
			(field) => field.alias ?? field.path[field.path.length - 1] ?? ""
		)
	);
}

/**
 * Pipeline strict : un `pick` droppe les colonnes non projetées. Une étape suivante qui
 * référence une colonne droppée est une erreur (« placez pick après cette étape »).
 */
function checkColumnsAvailable(
	stage: Stage,
	available: ReadonlySet<string> | null
): void {
	if (available === null) {
		return; // avant tout `pick`, toutes les colonnes sont disponibles
	}
	const referenced: (readonly string[])[] = [];
	switch (stage.type) {
		case "where":
			collectExprFields(stage.predicate, referenced);
			break;
		case "sort":
			for (const key of stage.keys) {
				referenced.push(key.path);
			}
			break;
		case "pick":
			for (const field of stage.fields) {
				referenced.push(field.path);
			}
			break;
		case "with":
			referenced.push(stage.localField); // le champ distant vient de la collection jointe
			break;
		case "limit":
			return;
	}
	for (const path of referenced) {
		const column = path[0] ?? "";
		if (!available.has(column)) {
			throw new SnqlError(
				`La colonne '${column}' a été retirée par un 'pick' précédent — placez 'pick' après cette étape.`,
				"lower_column_unavailable"
			);
		}
	}
}

function collectExprFields(expr: Expr, out: (readonly string[])[]): void {
	switch (expr.type) {
		case "field":
			out.push(expr.path);
			return;
		case "literal":
			return;
		case "compare":
		case "logical":
			collectExprFields(expr.left, out);
			collectExprFields(expr.right, out);
			return;
		case "not":
			collectExprFields(expr.operand, out);
			return;
		case "in":
			collectExprFields(expr.target, out);
			for (const value of expr.values) {
				collectExprFields(value, out);
			}
			return;
	}
}

/** Retire l'alias de tête d'un chemin (`u.id` → `id`) quand il correspond. */
function stripAlias(
	path: readonly string[],
	alias: string | undefined
): readonly string[] {
	return alias !== undefined && path.length > 1 && path[0] === alias
		? path.slice(1)
		: path;
}

function lowerStage(
	input: LogicalPlan,
	stage: Stage,
	sourceAlias: string | undefined
): LogicalPlan {
	switch (stage.type) {
		case "where":
			return { op: "filter", input, predicate: lowerExpr(stage.predicate) };
		case "pick": {
			const fields = stage.fields.map(lowerField);
			assertUniqueProjectionKeys(fields);
			return { op: "project", input, fields };
		}
		case "sort":
			return { op: "sort", input, keys: stage.keys.map(lowerSortKey) };
		case "limit":
			return stage.offset !== undefined
				? { op: "limit", input, count: stage.count, offset: stage.offset }
				: { op: "limit", input, count: stage.count };
		case "with":
			return {
				op: "join",
				input,
				collection: stage.collection,
				as: stage.alias ?? stage.collection,
				// localField vient de la source (strip son alias), foreignField de la collection jointe.
				localField: stripAlias(stage.localField, sourceAlias),
				foreignField: stripAlias(
					stage.foreignField,
					stage.alias ?? stage.collection
				)
			};
	}
}

function lowerField(field: FieldSelection): PlanProjectField {
	return field.alias !== undefined
		? { path: field.path, alias: field.alias }
		: { path: field.path };
}

/** Nom de sortie d'une projection = alias, sinon dernier segment du chemin. Doivent être uniques. */
function assertUniqueProjectionKeys(fields: readonly PlanProjectField[]): void {
	const seen = new Set<string>();
	for (const field of fields) {
		const key = field.alias ?? field.path[field.path.length - 1] ?? "";
		if (seen.has(key)) {
			throw new SnqlError(
				`Colonne de projection dupliquée '${key}' — désambiguïsez avec un alias (… as …)`,
				"lower_duplicate_projection"
			);
		}
		seen.add(key);
	}
}

function lowerSortKey(key: SortKey): PlanSortKey {
	return { path: key.path, direction: key.direction };
}

// Indice de flottant : présence d'un point décimal ou d'un exposant.
const FLOAT_HINT = /[.eE]/;

const COMPARE_MAP: Readonly<Record<CompareOperator, CompareOp>> = {
	"=": "eq",
	"!=": "ne",
	"<": "lt",
	">": "gt",
	"<=": "le",
	">=": "ge",
	like: "like"
};

function lowerExpr(expr: Expr): PlanExpr {
	switch (expr.type) {
		case "literal":
			return { kind: "literal", value: literalToValue(expr.value) };
		case "field":
			return { kind: "field", path: expr.path };
		case "compare":
			return lowerCompare(
				expr.operator,
				lowerExpr(expr.left),
				lowerExpr(expr.right)
			);
		case "logical":
			return expr.operator === "and"
				? {
						kind: "and",
						left: lowerExpr(expr.left),
						right: lowerExpr(expr.right)
					}
				: {
						kind: "or",
						left: lowerExpr(expr.left),
						right: lowerExpr(expr.right)
					};
		case "not":
			return { kind: "not", operand: lowerExpr(expr.operand) };
		case "in":
			return {
				kind: "in",
				target: lowerExpr(expr.target),
				values: expr.values.map(lowerExpr)
			};
	}
}

/** Opérateur symétrique après échange des opérandes (a < b ⇔ b > a). */
const FLIP_OP: Readonly<Record<CompareOp, CompareOp>> = {
	eq: "eq",
	ne: "ne",
	lt: "gt",
	gt: "lt",
	le: "ge",
	ge: "le",
	like: "like"
};

/**
 * Canonicalise une comparaison :
 * 1. null-aware, quel que soit le côté du littéral null (`x = null`, `null = x`, …) → isNull ;
 * 2. `littéral OP champ` → `champ OP' littéral` (opérande champ à gauche). Sans ça, un moteur
 *    document (Mongo) traduit `age < 30` et `30 > age` en formes différentes, avec des sémantiques
 *    divergentes sur les champs absents. Le fallback champ↔champ ($expr) reste, lui, inchangé.
 */
function lowerCompare(
	operator: CompareOperator,
	left: PlanExpr,
	right: PlanExpr
): PlanExpr {
	const op = COMPARE_MAP[operator];
	if (op === "eq" || op === "ne") {
		const leftNull = isNullLiteral(left);
		const rightNull = isNullLiteral(right);
		if (leftNull || rightNull) {
			const operand = leftNull ? right : left;
			return { kind: "isNull", negated: op === "ne", operand };
		}
	}
	// `like` n'est pas commutatif : jamais d'échange.
	if (op !== "like" && left.kind !== "field" && right.kind === "field") {
		return { kind: "compare", op: FLIP_OP[op], left: right, right: left };
	}
	return { kind: "compare", op, left, right };
}

function isNullLiteral(expr: PlanExpr): boolean {
	return expr.kind === "literal" && expr.value === null;
}

function literalToValue(lit: LiteralValue): SqlValue {
	switch (lit.kind) {
		case "number":
			return numberRawToValue(lit.raw);
		case "string":
			return lit.value;
		case "boolean":
			return lit.value;
		case "null":
			return null;
	}
}

/** Préserve la précision : entier hors plage sûre → bigint ; sinon number. */
function numberRawToValue(raw: string): number | bigint {
	if (FLOAT_HINT.test(raw)) {
		return Number(raw);
	}
	const asNumber = Number(raw);
	return Number.isSafeInteger(asNumber) ? asNumber : BigInt(raw);
}
