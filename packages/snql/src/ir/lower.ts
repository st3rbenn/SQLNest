import { toCompensationOp } from "../planner/planner";
import type { SchemaModel } from "../schema/model";
import { lowerMutation } from "./lower-mutation";
import { lower } from "./lower-query";
import { linearize } from "./plan";

export { lowerLet } from "./lower-let";
export { lowerMutation } from "./lower-mutation";
export { lower } from "./lower-query";

/**
 * Points d'entrée de l'abaissement de l'AST en plan logique. Les familles
 * de clauses vivent dans les modules `lower-*` voisins ; ce fichier reste
 * le chemin d'import public.
 */

/**
 * abaisse un `transaction [isolation …] { … }` en
 * TransactionPlan. Chaque item du body est lowered via `lower()` (read)
 * ou `lowerMutation()` (write). Les savepoints récursent. Le typecheck
 * mutation appliqué par lowerMutation reste valide (chaque write item
 * garde son propre scope).
 */
export function lowerTransaction(
	statement: import("../parser/ast").TransactionStatement,
	schema?: SchemaModel
): import("./plan").TransactionPlan {
	const body = statement.body.map((item) => lowerTransactionItem(item, schema));
	return statement.isolation !== undefined
		? { op: "transaction", isolation: statement.isolation, body }
		: { op: "transaction", body };
}

function lowerTransactionItem(
	item: import("../parser/ast").TransactionBodyItem,
	schema: SchemaModel | undefined
): import("./plan").TransactionPlanItem {
	if (item.operation === "savepoint") {
		return {
			kind: "savepoint",
			name: item.name,
			body: item.body.map((sub) => lowerTransactionItem(sub, schema))
		};
	}
	if (item.operation === "select") {
		return { kind: "read", plan: lower(item, schema) };
	}
	// insert / update / delete
	return { kind: "write", plan: lowerMutation(item, schema) };
}

/**
 * abaisse un statement d'introspection.
 * les stages `where`/`pick`/`sort`/`limit` sont lowered via
 * une fausse Query (source virtuelle `__introspect__`), puis extraits en
 * ops post-scan et convertis en CompensationOp. PG les inline dans un SELECT
 * wrapper, Mongo les applique via compensate() côté engine.
 */
/**
 * `raw "SQL"` / `raw {...}` — pass-through direct. Aucun
 * typecheck ni capability check ; c'est un escape hatch, l'utilisateur
 * assume la sémantique.
 */
export function lowerRaw(
	statement: import("../parser/ast").RawStatement
): import("./plan").RawPlan {
	return { op: "raw", payload: statement.payload };
}

export function lowerIntrospect(
	statement: import("../parser/ast").IntrospectStatement,
	_schema?: SchemaModel
): import("./plan").IntrospectPlan {
	const base: import("./plan").IntrospectPlan =
		statement.target !== undefined
			? { op: "introspect", kind: statement.kind, target: statement.target }
			: { op: "introspect", kind: statement.kind };
	if (statement.stages === undefined || statement.stages.length === 0) {
		return base;
	}
	const postOps = lowerIntrospectStages(statement.stages, statement.span);
	return { ...base, postOps };
}

/**
 * Lowere les stages d'un introspect via l'infra Query (réutilise checkColumnsAvailable
 * / typecheck / stripAlias). La source virtuelle `__introspect__` n'existe dans
 * aucun SchemaModel → `sourceColumns` = null → mode permissif (skip alias
 * checks). C'est le comportement voulu : le shape stable de l'introspect ne
 * s'auto-décrit pas au niveau SchemaModel.
 */
function lowerIntrospectStages(
	stages: readonly import("../parser/ast").Stage[],
	span: import("../lexer/token").Span
): readonly import("../planner/planner").CompensationOp[] {
	const fakeQuery: import("../parser/ast").Query = {
		operation: "select",
		verb: "get",
		source: { collection: "__introspect__", span },
		stages,
		span
	};
	const plan = lower(fakeQuery);
	const linear = linearize(plan);
	// Le premier op est le scan virtuel — on ne le compense pas.
	return linear.slice(1).map((op) => toCompensationOp(op));
}
