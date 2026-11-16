import { SnqlError } from "../diagnostics";
import { SNQL_FUNCTIONS } from "../functions";
import type {
	Assignment,
	DeleteStatement,
	Expr,
	InsertStatement,
	OnConflictClause,
	UpdateStatement
} from "../parser/ast";
import { READONLY_SYSTEM_TARGETS } from "../planner/introspect/support";
import type { SchemaModel } from "../schema/model";
import {
	refuseAggregateInPosition,
	refuseWindowCallInPosition
} from "./lower-aggregates";
import {
	checkExprPathsAgainstColumns,
	closestColumnHint,
	resolveSourceColumns
} from "./lower-columns";
import {
	assertNoBareCallPredicate,
	literalToValue,
	lowerExpr
} from "./lower-expr";
import { lower } from "./lower-query";
import { typecheckMutation } from "./lower-typecheck";
import { applyNativeNamesToMutation } from "./native-names";
import type {
	MutationPlan,
	PlanColumnValue,
	PlanExpr,
	PlanOnConflict,
	PlanRowValue
} from "./plan";
import { defined } from "../invariant";

/**
 * Écritures : `add`, `update`, `remove`, upsert et `add … from <requête>`.
 */

/**
 * Abaisse une mutation (insert / update / delete) en [[MutationPlan]].
 *
 * Le `schema` optionnel branche `checkAliasDefined` sur les mutations aussi —
 * les mutations n'ont pas de notion d'alias source, donc TOUT `path.length ≥ 2`
 * dans un predicate WHERE ou une valeur SET dont le head n'est pas une colonne
 * document de la collection est un alias inventé qui produirait un
 * `missing FROM-clause entry for table "x"` opaque au runtime. Symétrique du
 * garde côté lecture.
 */
export function lowerMutation(
	statement: InsertStatement | UpdateStatement | DeleteStatement,
	schema?: SchemaModel
): MutationPlan {
	return withTriggeredWrite(
		applyNativeNamesToMutation(lowerMutationPlan(statement, schema), schema),
		schema
	);
}

/**
 * SQL Server : une table qui a un trigger pour l'écriture refuse `OUTPUT` sans
 * `INTO` (334) ; le codegen relit alors les lignes écrites par leur clé. Un
 * upsert (MERGE) peut insérer comme mettre à jour.
 */
function withTriggeredWrite(
	plan: MutationPlan,
	schema: SchemaModel | undefined
): MutationPlan {
	if (schema?.engine !== "mssql" || plan.returnRowCount === true) return plan;
	const collection = schema.collections.find((c) => c.name === plan.collection);
	const events = new Set(collection?.triggers ?? []);
	const fires =
		plan.op === "insert" && plan.onConflict !== undefined
			? events.has("insert") || events.has("update")
			: events.has(plan.op);
	if (!fires || collection === undefined) return plan;
	const unique = collection.indexes?.find((i) => i.unique)?.columns;
	return {
		...plan,
		triggered: { keys: collection.primaryKey ?? unique ?? [] }
	};
}

function lowerMutationPlan(
	statement: InsertStatement | UpdateStatement | DeleteStatement,
	schema?: SchemaModel
): MutationPlan {
	// Refuse toute mutation sur une table système SQLNest readonly. Cohérent
	// avec le refus `find schema_events` — le contract SNQL classe la table
	// comme readonly par défaut, aucune surface d'écriture user.
	assertNotReadonlySystemTarget(statement.collection, statement.span);
	if (statement.operation === "insert") {
		return lowerInsert(statement, schema);
	}
	// typecheck predicate + set values si schema dispo.
	typecheckMutation(statement, schema);
	const sourceColumns = resolveSourceColumns(schema, statement.collection);
	if (statement.operation === "update") {
		assertUniqueAssignments(statement.assignments);
		// joins mutation — refus `with many`, résolution alias +
		// keys, validation contre schema.
		const loweredJoins = lowerUpdateJoins(statement, schema);
		const allowedAliases = collectMutationAliases(statement, loweredJoins);
		if (sourceColumns !== null) {
			for (const a of statement.assignments) {
				// v3.1 : check la col cible (LHS) contre le schema — `set unknown_col
				// = "x"` passait silencieux jusqu'à runtime.
				if (!sourceColumns.has(a.column)) {
					const hint = closestColumnHint(a.column, sourceColumns);
					throw new SnqlError(
						`'${a.column}' n'est pas une colonne de '${statement.collection}'${hint}.`,
						"lower_unknown_column"
					);
				}
				checkExprPathsAgainstColumns(
					a.value,
					sourceColumns,
					statement.collection,
					allowedAliases
				);
			}
			if (statement.predicate !== undefined) {
				checkExprPathsAgainstColumns(
					statement.predicate,
					sourceColumns,
					statement.collection,
					allowedAliases
				);
			}
		}
		if (statement.predicate !== undefined)
			assertNoBareCallPredicate(statement.predicate);
		const assignments = statement.assignments.map((assignment) => ({
			column: assignment.column,
			value: lowerExpr(assignment.value)
		}));
		// aggregate dans set — refus AVANT assertNoCallInWrite
		// (ordre CRITIQUE : message précis, pas générique lower_call_null_write).
		// window aussi refusé en set (per-row-context inutile
		// pour un update).
		for (const [i, a] of assignments.entries()) {
			refuseWindowCallInPosition(
				defined(statement.assignments[i]).value,
				"lower_window_in_set",
				`set ${a.column}`
			);
			refuseAggregateInPosition(
				a.value,
				"lower_agg_in_set",
				`'set ${a.column} = <aggregate>' non supporté — l'aggregate n'a pas de sens en écriture (une seule row cible)`
			);
			assertNoCallInWrite(a.value);
		}
		if (statement.predicate !== undefined) {
			refuseWindowCallInPosition(
				statement.predicate,
				"lower_window_in_write_predicate",
				"where d'update"
			);
		}
		const predicate =
			statement.predicate !== undefined
				? lowerExpr(statement.predicate)
				: undefined;
		if (predicate !== undefined) {
			refuseAggregateInPosition(
				predicate,
				"lower_agg_in_where",
				"Aggregate dans 'where' d'update interdit — un aggregate produit une valeur globale, pas un prédicat par row; utilise une sous-requête ou matérialise le count côté application"
			);
			assertNoCallInWrite(predicate);
		}
		const rrc =
			statement.returnRowCount === true
				? { returnRowCount: true as const }
				: {};
		const aliasOpt =
			statement.alias !== undefined ? { alias: statement.alias } : {};
		const joinsOpt = loweredJoins.length > 0 ? { joins: loweredJoins } : {};
		return predicate !== undefined
			? {
					op: "update",
					collection: statement.collection,
					...aliasOpt,
					...joinsOpt,
					assignments,
					predicate,
					...rrc
				}
			: {
					op: "update",
					collection: statement.collection,
					...aliasOpt,
					...joinsOpt,
					assignments,
					...rrc
				};
	}
	if (sourceColumns !== null && statement.predicate !== undefined) {
		checkExprPathsAgainstColumns(
			statement.predicate,
			sourceColumns,
			statement.collection
		);
	}
	if (statement.predicate !== undefined)
		assertNoBareCallPredicate(statement.predicate);
	if (statement.predicate !== undefined) {
		refuseWindowCallInPosition(
			statement.predicate,
			"lower_window_in_write_predicate",
			"where de delete"
		);
	}
	const predicate =
		statement.predicate !== undefined
			? lowerExpr(statement.predicate)
			: undefined;
	if (predicate !== undefined) {
		// aggregate dans predicate de delete — refus AVANT write.
		refuseAggregateInPosition(
			predicate,
			"lower_agg_in_delete_predicate",
			"Aggregate dans 'where' de delete interdit — un aggregate produit une valeur globale, pas un prédicat par row; utilise une sous-requête ou matérialise le count côté application"
		);
		assertNoCallInWrite(predicate);
	}
	const rrcDelete =
		statement.returnRowCount === true ? { returnRowCount: true as const } : {};
	return predicate !== undefined
		? {
				op: "delete",
				collection: statement.collection,
				predicate,
				...rrcDelete
			}
		: { op: "delete", collection: statement.collection, ...rrcDelete };
}

/**
 * abaisse la liste des `with one X on l=f` d'un update. Refuse
 * `with many` (`lower_write_join_many` — évite un UPDATE cartésien silencieux),
 * valide que chaque local field est une col de la source, retourne la liste
 * PlanUpdateJoin prête pour le codegen. Les cross-refs entre joins (join B
 * référence l'alias de join A) sont autorisées via allowedAliases.
 */
function lowerUpdateJoins(
	statement: UpdateStatement,
	schema: SchemaModel | undefined
): readonly import("./plan").PlanUpdateJoin[] {
	if (statement.joins === undefined || statement.joins.length === 0) return [];
	const sourceColumns = resolveSourceColumns(schema, statement.collection);
	const out: import("./plan").PlanUpdateJoin[] = [];
	for (const stage of statement.joins) {
		if (stage.type !== "with") continue; // defense parse invariant
		if (stage.multiplicity === "many") {
			throw new SnqlError(
				"'with many' interdit dans un update (produit un UPDATE cartésien silencieux) — utilise 'with one X on l=f' pour un join 1-1.",
				"lower_write_join_many",
				stage.span
			);
		}
		// Validate local field is a source column (schema disponible).
		if (sourceColumns !== null) {
			const localHead = stage.localField[0];
			if (
				localHead !== undefined &&
				!sourceColumns.has(localHead) &&
				localHead !== statement.collection &&
				localHead !== statement.alias
			) {
				// Autorise cross-ref à un alias déjà déclaré côté joins précédents
				const priorAliases = new Set(out.map((j) => j.as));
				if (!priorAliases.has(localHead)) {
					throw new SnqlError(
						`'with one ${stage.collection} on ${stage.localField.join(".")} = …' — la colonne '${localHead}' n'appartient ni à '${statement.collection}' ni à un alias déjà déclaré.`,
						"lower_write_join_unknown_local",
						stage.span
					);
				}
			}
		}
		out.push({
			collection: stage.collection,
			as: stage.alias ?? stage.collection,
			localField: stage.localField,
			foreignField: stage.foreignField
		});
	}
	return out;
}

/** ensemble des alias autorisés dans set/where d'un update. */
function collectMutationAliases(
	statement: UpdateStatement,
	joins: readonly import("./plan").PlanUpdateJoin[]
): ReadonlySet<string> {
	const out = new Set<string>();
	if (statement.alias !== undefined) out.add(statement.alias);
	out.add(statement.collection);
	for (const j of joins) out.add(j.as);
	return out;
}

/**
 * Refuse un `call` en contexte write (predicate d'update/delete + valeurs de
 * set) sauf si sa sémantique NULL est explicitement déclarée via
 * `writeNullBehavior` (propagate/absorb/custom/deterministic). Récursion
 * conservée pour attraper un call sous cast/arith/etc. — un cast passe
 * (déterministe), mais `set y = cast(concat(x, "!") as text)` refuse concat.
 */
function assertNoCallInWrite(expr: PlanExpr): void {
	switch (expr.kind) {
		case "call": {
			const entry = SNQL_FUNCTIONS.get(expr.name);
			if (entry?.writeNullBehavior === undefined) {
				throw new SnqlError(
					`Fonction '${expr.name}' non autorisée dans un contexte d'écriture (update/remove) — sémantique NULL non déclarée`,
					"lower_call_null_write"
				);
			}
			// Récursion sur les args : un call safe peut wrapper un call non-safe.
			for (const arg of expr.args) assertNoCallInWrite(arg);
			return;
		}
		case "literal":
		case "field":
			return;
		case "arith":
		case "compare":
		case "and":
		case "or":
			assertNoCallInWrite(expr.left);
			assertNoCallInWrite(expr.right);
			return;
		case "not":
		case "isNull":
			assertNoCallInWrite(expr.operand);
			return;
		case "in":
			assertNoCallInWrite(expr.target);
			for (const v of expr.values) assertNoCallInWrite(v);
			return;
		case "cast":
			// Cast lui-même passe : déterministe + NULL propagate → prévisible en write.
			// La récursion attrape un `call` sous-jacent (ex: cast(upper(x) as text)).
			assertNoCallInWrite(expr.operand);
			return;
		case "object":
			// Object literal passe (structure statique) — récurse sur chaque value
			// pour attraper un call non-safe imbriqué.
			for (const entry of expr.entries) assertNoCallInWrite(entry.value);
			return;
		case "array":
			for (const item of expr.items) assertNoCallInWrite(item);
			return;
		case "case":
			// Case structure : récurse cond+value de chaque branche + elseValue.
			// Le case lui-même est déterministe (structure statique), un call
			// non-safe dans une branche est attrapé récursivement.
			for (const branch of expr.branches) {
				assertNoCallInWrite(branch.cond);
				assertNoCallInWrite(branch.value);
			}
			assertNoCallInWrite(expr.elseValue);
			return;
		case "windowCall":
			throw new SnqlError(
				`Window function '${expr.name}' non autorisée dans un contexte d'écriture`,
				"lower_window_in_write",
				expr.span
			);
		case "subquery":
		case "exists":
			// sub-queries refusées en write v1 — sémantique
			// complexe (correlated updates). Read-only pour l'instant.
			throw new SnqlError(
				"Sub-query dans un contexte d'écriture (update/remove) non supportée v1 — matérialise le résultat côté application",
				"lower_subquery_in_write",
				expr.span
			);
	}
}

/**
 * Abaisse un `insert`. Toutes les lignes doivent partager le MÊME jeu de colonnes
 * (un INSERT multi-lignes a une liste de colonnes unique). Les valeurs doivent
 * être des littéraux. Colonnes absentes d'un document = document hétérogène → erreur.
 *
 * Produit également des arrays parallèles `rowSpans` / `cellSpans` (Phase 3c) —
 * pour un `add [{...}, {...}]`, chaque row du plan garde la trace de son span
 * source et chaque cellule de son span (à la fois utilisés par le codegen pour
 * paramétrer avec span, et remontés dans le pgError pour cibler une row
 * fautive sur unique/FK violation).
 */
function lowerInsert(
	statement: InsertStatement,
	schema?: SchemaModel
): MutationPlan {
	// INSERT SELECT — `add (find … pick a, b) into t`.
	// Le mapping cols cibles est inféré du `pick` (`x as tgt_col` → tgt_col,
	// sinon dernier segment du path). Refus si pas de pick, si onConflict
	// combiné (v1), si engine != PG (au planner).
	if (statement.sourceQuery !== undefined) {
		return lowerInsertSelect(statement, schema);
	}
	const firstRow = statement.rows[0];
	if (firstRow === undefined) {
		throw new SnqlError("'add' sans document", "lower_insert_empty");
	}
	const columns = firstRow.fields.map((field) => field.column);
	const columnSet = new Set(columns);
	if (columnSet.size !== columns.length) {
		throw new SnqlError(
			"Clé dupliquée dans un document d'insertion",
			"lower_insert_duplicate_key"
		);
	}

	const rowSpans: (import("../lexer/token").Span | undefined)[] = [];
	const cellSpans: (readonly (import("../lexer/token").Span | undefined)[])[] =
		[];
	const rows = statement.rows.map((row) => {
		const byColumn = new Map<string, Expr>();
		for (const field of row.fields) {
			if (byColumn.has(field.column)) {
				throw new SnqlError(
					`Clé '${field.column}' dupliquée dans un document d'insertion`,
					"lower_insert_duplicate_key"
				);
			}
			byColumn.set(field.column, field.value);
		}
		if (byColumn.size !== columnSet.size) {
			throw new SnqlError(
				"Documents d'insertion à colonnes hétérogènes (colonnes identiques requises)",
				"lower_insert_heterogeneous"
			);
		}
		const rowCellSpans: (import("../lexer/token").Span | undefined)[] = [];
		const values = columns.map((column) => {
			const value = byColumn.get(column);
			if (value === undefined) {
				throw new SnqlError(
					`Colonne '${column}' absente d'un document d'insertion`,
					"lower_insert_heterogeneous"
				);
			}
			// Le span est celui du littéral value — c'est ce qui devient un $N côté
			// codegen SQL, donc c'est ce qui doit remonter dans paramSpans.
			rowCellSpans.push(value.span);
			return literalOf(value, column);
		});
		rowSpans.push(row.span);
		cellSpans.push(rowCellSpans);
		return values;
	});

	// on-conflict clause.
	const sourceColumns = resolveSourceColumns(schema, statement.collection);
	// v3.1 : check les keys du doc contre le schema — un typo `bad_col` remontait
	// silencieux jusqu'à PG (`column "bad_col" does not exist`) et pas du tout côté
	// Mongo (créait un doc avec un champ inconnu). Live diag remontera maintenant.
	if (sourceColumns !== null) {
		for (const col of columns) {
			if (sourceColumns.has(col)) continue;
			const hint = closestColumnHint(col, sourceColumns);
			throw new SnqlError(
				`'${col}' n'est pas une colonne de '${statement.collection}'${hint}.`,
				"lower_unknown_column"
			);
		}
	}
	const onConflict =
		statement.onConflict !== undefined
			? lowerOnConflict(
					statement.onConflict,
					columnSet,
					sourceColumns,
					statement.collection
				)
			: undefined;
	const returnRowCount =
		statement.returnRowCount === true ? { returnRowCount: true as const } : {};

	return {
		op: "insert",
		collection: statement.collection,
		columns,
		rows,
		rowSpans,
		cellSpans,
		...(onConflict !== undefined ? { onConflict } : {}),
		...returnRowCount
	};
}

/**
 * abaisse un `on conflict (keys) [ignore | edit set …]`.
 *  - Valide que chaque `key` est un ident insérable (dans `columnSet`) et,
 *    si schema présent, une colonne réelle de la source. Sans key réelle sur
 *    la table (contrainte UNIQUE / PK), PG lèvera un `42P10 there is no
 *    unique or exclusion constraint matching` au runtime — le lower ne peut
 *    pas anticiper ça sans introspection des contraintes.
 *  - Pour l'action `update`, abaisse chaque assignment et le where en
 *    transformant les `field {path:["new", col]}` en `PlanExpr.upsertNew`.
 */
function lowerOnConflict(
	clause: OnConflictClause,
	insertColumns: ReadonlySet<string>,
	sourceColumns: ReadonlySet<string> | null,
	collection: string
): PlanOnConflict {
	// Sanity : keys non vides + keys uniques + keys existent.
	if (clause.keys.length === 0) {
		throw new SnqlError(
			"'on conflict (…)' attend au moins une colonne clé",
			"lower_on_conflict_empty_keys",
			clause.span
		);
	}
	const seenKeys = new Set<string>();
	for (const k of clause.keys) {
		if (seenKeys.has(k)) {
			throw new SnqlError(
				`Colonne '${k}' dupliquée dans 'on conflict (…)'`,
				"lower_on_conflict_duplicate_key",
				clause.span
			);
		}
		seenKeys.add(k);
		if (sourceColumns !== null && !sourceColumns.has(k)) {
			throw new SnqlError(
				`Colonne '${k}' de 'on conflict (…)' inconnue dans '${collection}'`,
				"lower_on_conflict_unknown_key",
				clause.span
			);
		}
	}

	if (clause.action.kind === "ignore") {
		return { keys: clause.keys, action: { kind: "ignore" } };
	}

	// Action `update` : valider assignments (uniques + colonnes existent), abaisser
	// les valeurs avec rewrite `new.x` → upsertNew, valider aussi le where.
	const assignments: Assignment[] = [...clause.action.assignments];
	assertUniqueAssignments(assignments);
	if (sourceColumns !== null) {
		for (const a of assignments) {
			if (!sourceColumns.has(a.column)) {
				throw new SnqlError(
					`Colonne '${a.column}' d''edit set' inconnue dans '${collection}'`,
					"lower_on_conflict_unknown_set_column",
					a.span
				);
			}
		}
	}
	const loweredAssignments: PlanColumnValue[] = assignments.map((a) => ({
		column: a.column,
		value: lowerUpsertExpr(a.value, insertColumns, sourceColumns, collection)
	}));
	const where =
		clause.action.where !== undefined
			? lowerUpsertExpr(
					clause.action.where,
					insertColumns,
					sourceColumns,
					collection
				)
			: undefined;
	// Refus aggregate/window/subquery/call-null-write dans les upsert exprs
	// (parité update ordinaire).
	for (const [i, a] of loweredAssignments.entries()) {
		refuseWindowCallInPosition(
			defined(clause.action.assignments[i]).value,
			"lower_window_in_set",
			`on conflict edit set ${a.column}`
		);
		refuseAggregateInPosition(
			a.value,
			"lower_agg_in_set",
			`'edit set ${a.column} = <aggregate>' non supporté dans 'on conflict'`
		);
		assertNoCallInWrite(a.value);
	}
	if (where !== undefined) {
		refuseAggregateInPosition(
			where,
			"lower_agg_in_where",
			"Aggregate dans 'on conflict … where' interdit"
		);
		assertNoCallInWrite(where);
	}

	return {
		keys: clause.keys,
		action: {
			kind: "update",
			assignments: loweredAssignments,
			...(where !== undefined ? { where } : {})
		}
	};
}

/**
 * abaisse une expression du scope on-conflict edit-set/where.
 * D'abord lower normal, puis rewrite `field {path:["new", col]}` en
 * `upsertNew {column: col}`. Valide le shape (2 segments exactement, col dans
 * insertColumns). Les path bare (`updated_at`) et `<table>.col` réfèrent la
 * row existante et restent field — PG les résout naturellement au nom de la
 * table cible.
 */
function lowerUpsertExpr(
	expr: Expr,
	insertColumns: ReadonlySet<string>,
	sourceColumns: ReadonlySet<string> | null,
	collection: string
): PlanExpr {
	const lowered = lowerExpr(expr);
	return rewriteUpsertNew(lowered, insertColumns, sourceColumns, collection);
}

function rewriteUpsertNew(
	node: PlanExpr,
	insertColumns: ReadonlySet<string>,
	sourceColumns: ReadonlySet<string> | null,
	collection: string
): PlanExpr {
	const rec = (n: PlanExpr): PlanExpr =>
		rewriteUpsertNew(n, insertColumns, sourceColumns, collection);
	switch (node.kind) {
		case "field": {
			const [head, ...tail] = node.path;
			if (head === "new") {
				if (tail.length !== 1) {
					throw new SnqlError(
						"'new.<col>' attend un unique segment (ex: 'new.updated_at') — les paths nested ne sont pas supportés",
						"lower_upsert_new_path_shape",
						node.span
					);
				}
				const col = defined(tail[0]);
				if (!insertColumns.has(col)) {
					throw new SnqlError(
						`'new.${col}' — la colonne '${col}' n'est pas dans le document inséré`,
						"lower_upsert_new_column_missing",
						node.span
					);
				}
				return node.span !== undefined
					? { kind: "upsertNew", column: col, span: node.span }
					: { kind: "upsertNew", column: col };
			}
			// path bare `col` ou `<collection>.col` réfère la row existante en DB.
			// PG résout naturellement au nom de la table cible.
			if (
				sourceColumns !== null &&
				head !== undefined &&
				node.path.length >= 2 &&
				head !== collection
			) {
				throw new SnqlError(
					`'${head}' n'est ni 'new' ni '${collection}' dans '${node.path.join(".")}' — dans 'on conflict', seuls le champ bare (row existante) et 'new.col' (row proposée) sont autorisés`,
					"lower_unknown_alias",
					node.span
				);
			}
			return node;
		}
		case "literal":
		case "upsertNew":
			return node;
		case "compare":
			return { ...node, left: rec(node.left), right: rec(node.right) };
		case "and":
		case "or":
			return { ...node, left: rec(node.left), right: rec(node.right) };
		case "not":
		case "isNull":
			return { ...node, operand: rec(node.operand) };
		case "in":
			return {
				...node,
				target: rec(node.target),
				values: node.values.map(rec)
			};
		case "arith":
			return { ...node, left: rec(node.left), right: rec(node.right) };
		case "call":
			return { ...node, args: node.args.map(rec) };
		case "cast":
			return { ...node, operand: rec(node.operand) };
		case "object":
			return {
				...node,
				entries: node.entries.map((e) => ({ key: e.key, value: rec(e.value) }))
			};
		case "array":
			return { ...node, items: node.items.map(rec) };
		case "case":
			return {
				...node,
				branches: node.branches.map((b) => ({
					cond: rec(b.cond),
					value: rec(b.value)
				})),
				elseValue: rec(node.elseValue)
			};
		case "windowCall":
		case "subquery":
		case "exists":
			// Refus attrapés en amont : refuseAggregateInPosition / refuseWindow
			// pour aggregate/window, lower_subquery_in_write pour subquery.
			return node;
	}
}

/**
 * Une valeur d'insertion accepte : un littéral scalaire, OU un object/array
 * literal (composite JSON). Le widening `PlanRowValue` sépare les 2 cas pour
 * dispatcher au codegen (`params.add(scalar)` vs `renderExpr(jsonLiteral)`).
 * Les autres kinds (field, arith, call, cast) restent refusés — un insert
 * n'est pas un select.
 */
/**
 * abaisse `add (find … pick a, b as tgt) into t` — le pick
 * est OBLIGATOIRE (mapping cols cibles inféré : `pick x as tgt_col` →
 * tgt_col ; sinon dernier segment du path).
 *  - Refus si pas de pick → lower_insert_select_no_pick
 *  - Refus pick avec `unique` / `distinctOnKeys` (v1, à réévaluer)
 *  - Refus onConflict combiné avec sourceQuery (v1)
 *  - Validation cols cibles existent dans schema (si dispo)
 * Le sourcePlan est abaissé via `lower()` récursif (qui gère alias + joins).
 */
function lowerInsertSelect(
	statement: InsertStatement,
	schema: SchemaModel | undefined
): MutationPlan {
	const sourceQuery = defined(statement.sourceQuery);
	if (statement.onConflict !== undefined) {
		throw new SnqlError(
			"'add (find …) into t on conflict …' non supporté v1 — sépare l'INSERT SELECT et l'upsert.",
			"lower_insert_select_with_on_conflict",
			statement.span
		);
	}
	const pickStage = sourceQuery.stages.find((s) => s.type === "pick");
	if (pickStage === undefined || pickStage.type !== "pick") {
		throw new SnqlError(
			"'add (find … pick …) into t' — la sub-query source exige un `pick` (mapping cols cibles inféré).",
			"lower_insert_select_no_pick",
			statement.span
		);
	}
	if (pickStage.unique === true || pickStage.distinctOnKeys !== undefined) {
		throw new SnqlError(
			"'add (find … pick unique …) into t' non supporté v1 — utilise un `pick` classique.",
			"lower_insert_select_unique_pick",
			pickStage.span
		);
	}
	const columns = pickStage.fields.map((f) => {
		if (f.alias !== undefined) return f.alias;
		return f.path[f.path.length - 1] ?? "";
	});
	const dupCol = findDuplicate(columns);
	if (dupCol !== null) {
		throw new SnqlError(
			`'add (find … pick …) into t' — colonne cible '${dupCol}' dupliquée dans le mapping. Utilise 'pick x as tgt' pour renommer.`,
			"lower_insert_select_duplicate_column",
			pickStage.span
		);
	}
	if (schema !== undefined) {
		const sourceCols = resolveSourceColumns(schema, statement.collection);
		if (sourceCols !== null) {
			for (const col of columns) {
				if (!sourceCols.has(col)) {
					throw new SnqlError(
						`'add (find … pick …) into ${statement.collection}' — colonne cible '${col}' inconnue. Renomme via 'pick x as ${col}' ou aligne le pick sur les cols de la target.`,
						"lower_insert_select_unknown_target",
						pickStage.span
					);
				}
			}
		}
	}
	const sourcePlan = lower(sourceQuery, schema);
	const rrc =
		statement.returnRowCount === true ? { returnRowCount: true as const } : {};
	return {
		op: "insert",
		collection: statement.collection,
		columns,
		rows: [],
		sourcePlan,
		...rrc
	};
}

function findDuplicate(items: readonly string[]): string | null {
	const seen = new Set<string>();
	for (const it of items) {
		if (seen.has(it)) return it;
		seen.add(it);
	}
	return null;
}

function literalOf(value: Expr, column: string): PlanRowValue {
	if (value.type === "literal") {
		return { kind: "scalar", value: literalToValue(value.value) };
	}
	if (value.type === "object" || value.type === "array") {
		// Composite JSON literal — lower récursivement pour produire PlanExpr,
		// que le codegen rendra via jsonb_build_object / BSON natif.
		return { kind: "jsonLiteral", expr: lowerExpr(value) };
	}
	throw new SnqlError(
		`La valeur de '${column}' doit être un littéral scalaire ou un object/array literal`,
		"lower_insert_non_literal"
	);
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

/**
 * Refuse toute mutation (add / update / remove) sur une table système
 * SQLNest en lecture seule. Cohérent avec `assertNotReservedSystemTarget` pour
 * les lectures — le contract SNQL classe la table système comme readonly par
 * défaut.
 */
function assertNotReadonlySystemTarget(
	collection: string,
	span: import("../lexer/token").Span
): void {
	if (!READONLY_SYSTEM_TARGETS.has(collection)) return;
	throw new SnqlError(
		`'${collection}' est une table système en lecture seule — utilise 'list ${collection}' pour la consulter.`,
		"planner_readonly_system_target",
		span
	);
}
