import { SnqlError } from "../diagnostics";
import { checkArity, SNQL_FUNCTIONS } from "../functions";
import type {
	Assignment,
	CastTarget,
	CompareOperator,
	DeleteStatement,
	Expr,
	FieldSelection,
	InsertStatement,
	LiteralValue,
	OnConflictClause,
	Query,
	SortKey,
	Stage,
	UpdateStatement
} from "../parser/ast";
import { CAST_TARGETS } from "../parser/ast";
import { toCompensationOp } from "../planner/planner";
import type {
	Relation,
	RelationKind,
	SchemaModel,
	SnqlType
} from "../schema/model";
import type {
	CompareOp,
	LogicalPlan,
	MutationPlan,
	PlanColumnValue,
	PlanExpr,
	PlanOnConflict,
	PlanProjectField,
	PlanRowValue,
	PlanSortKey,
	SqlValue
} from "./plan";
import { linearize } from "./plan";

/**
 * scope d'une query outer visible par une subquery corrélée.
 * Contient les alias déclarés (source + with-joins) + colonnes source pour
 * résoudre `alias.field` lookup depuis l'intérieur d'un `(find ...)`.
 */
interface OuterScope {
	readonly aliases: ReadonlySet<string>;
	readonly sourceColumns: ReadonlySet<string> | null;
	readonly collection: string;
	readonly alias?: string;
}

/**
 * Module-level scope stack — JS single-thread → safe. Push par lower() à
 * chaque entrée d'une subquery, pop à la sortie. Consulté par
 * checkAliasDefined pour résoudre les alias corrélés.
 *
 * NOTE : le stack contient les scopes OUTER, pas le scope courant. Le scope
 * courant est reconstruit par lowerInternal en direct depuis ses locals et
 * assigné à `currentScope` avant chaque appel à lowerExpr.
 */
const outerScopeStack: OuterScope[] = [];

/**
 * Scope courant de la query en cours de lowering — mis à jour par
 * lowerInternal après chaque stage `with` qui ajoute un alias. Poussé sur
 * outerScopeStack quand lower() est appelé récursivement (subquery).
 */
let currentScope: OuterScope | null = null;

const MAX_SUBQUERY_DEPTH = 32;

/**
 * Abaisse l'AST de surface en Logical Plan canonique (collapse des synonymes, etc.).
 *
 * Le [[SchemaModel]] optionnel permet d'inférer la multiplicité des joins `with`
 * depuis les relations introspectées : une relation many-to-one/one-to-one produit
 * un vrai LEFT JOIN (`kind: "join"`), une one-to-many/many-to-many produit un
 * embed en array (`kind: "embed"`). Sans schéma ou sans relation matchante, on
 * retombe sur `embed` (comportement historique). L'utilisateur peut forcer via
 * `with one X` / `with many X`.
 *
 * gère les sub-queries corrélées via un scope stack module-level
 * (poussé quand lowerExpr descend dans une subquery, popé au retour).
 */
let moduleSchema: SchemaModel | undefined; // schema courant pour lowerExpr subquery

export function lower(query: Query, schema?: SchemaModel): LogicalPlan {
	if (query.operation !== "select") {
		throw new SnqlError(
			`Opération '${query.operation}' non supportée en `,
			"lower_unsupported_operation"
		);
	}
	if (outerScopeStack.length > MAX_SUBQUERY_DEPTH) {
		throw new SnqlError(
			`Sub-queries imbriquées > ${MAX_SUBQUERY_DEPTH} — refactorise avec des CTE (T3)`,
			"lower_subquery_depth_exceeded",
			query.span
		);
	}
	// capture le schema courant pour que lowerExpr puisse le
	// propager aux subqueries. Push l'outer scope (currentScope) sur le
	// stack si on est en recursion — la subquery pourra lire ses alias
	// via checkAliasDefined.
	const previousSchema = moduleSchema;
	const previousCurrentScope = currentScope;
	moduleSchema = schema ?? moduleSchema;
	if (previousCurrentScope !== null) {
		outerScopeStack.push(previousCurrentScope);
	}
	try {
		return lowerInternal(query, schema ?? moduleSchema);
	} finally {
		if (previousCurrentScope !== null) outerScopeStack.pop();
		currentScope = previousCurrentScope;
		moduleSchema = previousSchema;
	}
}

function lowerInternal(query: Query, schema?: SchemaModel): LogicalPlan {
	// typecheck cross-type predicates si schema dispo.
	// Fire-early : messages actionnables avant PG remonte du 42883 cryptique.
	typecheckQuery(query, schema);

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
	// Alias des joins déjà rencontrés en mode `embed` — leurs champs sont
	// enveloppés dans un array JSON, `alias.field` n'est pas résolvable.
	const embedAliases = new Set<string>();
	// Alias déclarés valides pour préfixer un `path` (`x.field`). Contient
	// l'alias de la source (si présent) + tous les alias `with` vus jusqu'ici.
	// Sert à rejeter en amont un `alias.field` avec un alias jamais déclaré —
	// sinon on laisserait pg cracher un `missing FROM-clause entry for table
	// "x"` obscur qui référence un alias que l'utilisateur ne comprend pas.
	const knownAliases = new Set<string>();
	if (query.source.alias !== undefined) {
		knownAliases.add(query.source.alias);
	}
	// Sans schéma on ne peut pas distinguer `alias.field` (préfixe d'alias
	// jamais déclaré) d'un `col.subfield` (accès JSON à un champ imbriqué
	// d'une colonne document) — les deux ont la même shape `path.length ≥ 2`.
	// Idem si la source n'est pas dans le schéma OU si ses `fields` sont
	// vides (Mongo pré-sampling, stale post-DDL) — permissif via `null`.
	const sourceColumns = resolveSourceColumns(schema, query.source.collection);
	// initialise currentScope = scope de la query courante.
	// Réassigné dynamiquement après chaque `with` join qui ajoute un alias.
	// Consulté par le `lower()` récursif quand une subquery est rencontrée.
	const refreshCurrentScope = (): void => {
		currentScope = {
			aliases: new Set(knownAliases),
			sourceColumns,
			collection: query.source.collection,
			...(query.source.alias !== undefined ? { alias: query.source.alias } : {})
		};
	};
	refreshCurrentScope();
	// group by / having accumulation. Les stages `group` et
	// `having` ne produisent pas d'op IR directement — ils alimentent le `pick`
	// qui suit (groupKeys sur l'aggregate op, having comme filtre post-agg).
	let groupKeys: readonly (readonly string[])[] | undefined;
	let groupKeySpans: readonly import("../lexer/token").Span[] | undefined;
	let havingExpr: Expr | undefined;
	let havingSpan: import("../lexer/token").Span | undefined;
	let hasGroupStage = false;
	for (const stage of query.stages) {
		checkColumnsAvailable(stage, available, sourceColumns);
		if (stage.type !== "with") {
			checkNoEmbedAliasDeref(stage, embedAliases);
		}
		if (sourceColumns !== null) {
			checkAliasDefined(stage, knownAliases, sourceColumns, query.source);
		}
		// window function refusée dans where/having (per-row
		// context inutilisable pour filtrer, sub-query needed) — refus AVANT
		// lowerStage pour message précis.
		if (stage.type === "where") {
			refuseWindowCallInPosition(
				stage.predicate,
				"lower_window_in_where",
				"where"
			);
		}
		if (stage.type === "having") {
			refuseWindowCallInPosition(
				stage.predicate,
				"lower_window_in_having",
				"having"
			);
		}
		// check sort keys prefix-match distinctOnKeys (parité PG).
		// Le pick précédent peut avoir posé distinctOnKeys ; ici on vérifie que
		// les sort keys commencent par les mêmes paths (alias-stripped).
		if (
			stage.type === "sort" &&
			plan.op === "project" &&
			plan.distinctOnKeys !== undefined
		) {
			const onKeys = plan.distinctOnKeys;
			const sortKeyPaths = stage.keys.map((k) =>
				stripAlias(k.path, query.source.alias).join(".")
			);
			const prefixMatch = onKeys.every((k, i) => {
				const canonical = k.join(".");
				return sortKeyPaths[i] === canonical;
			});
			if (!prefixMatch) {
				throw new SnqlError(
					`'sort' après 'pick unique on (${onKeys.map((k) => k.join(".")).join(", ")})' doit commencer par ces keys — sinon la row conservée par groupe est indéterminée (parité PG DISTINCT ON)`,
					"lower_unique_on_sort_prefix_mismatch",
					stage.span
				);
			}
		}
		if (stage.type === "group") {
			if (stage.keys.length === 0) {
				throw new SnqlError(
					"'group by' attend au moins un champ",
					"lower_group_empty",
					stage.span
				);
			}
			// Strip source alias — `group by u.year` avec source `find users as u`
			// devient `group by year` en IR (aligné sort/pick paths).
			groupKeys = stage.keys.map((k) => stripAlias(k.path, query.source.alias));
			groupKeySpans = stage.keys.map((k) => k.span);
			// Dédup — `group by x, x` = erreur claire au lower.
			const seen = new Set<string>();
			for (const key of groupKeys) {
				const canonical = key.join(".");
				if (seen.has(canonical)) {
					throw new SnqlError(
						`Clé '${canonical}' dupliquée dans 'group by'`,
						"lower_group_duplicate_key",
						stage.span
					);
				}
				seen.add(canonical);
			}
			hasGroupStage = true;
			continue;
		}
		if (stage.type === "having") {
			if (!hasGroupStage) {
				throw new SnqlError(
					"'having' exige un 'group by' en amont — écris 'group by <champ> having <condition>'",
					"lower_having_without_group",
					stage.span
				);
			}
			havingExpr = stage.predicate;
			havingSpan = stage.span;
			continue;
		}
		plan = lowerStage(
			plan,
			stage,
			query.source.collection,
			query.source.alias,
			schema,
			groupKeys
		);
		if (stage.type === "pick") {
			// si having accumulé, l'injecter dans l'op aggregate.
			// having exige un group by (validé plus haut) → plan racine est
			// forcément un aggregate avec groupKeys ici.
			if (havingExpr !== undefined) {
				if (plan.op !== "aggregate") {
					throw new SnqlError(
						"'having' exige que le 'pick' contienne un aggregate — utilise 'where' pour filtrer sur des scalaires",
						"lower_having_without_aggregate",
						havingSpan
					);
				}
				const groupKeySet =
					groupKeys !== undefined
						? new Set(groupKeys.map((k) => k.join(".")))
						: undefined;
				validateHavingAst(havingExpr, groupKeySet, query.source.alias);
				const loweredHaving = lowerExpr(havingExpr);
				plan = {
					op: "aggregate",
					input: plan.input,
					fields: plan.fields,
					...(plan.groupKeys !== undefined
						? { groupKeys: plan.groupKeys }
						: {}),
					having: loweredHaving
				};
				havingExpr = undefined;
			}
			available = projectionKeys(stage.fields);
		} else if (stage.type === "with") {
			if (available !== null) {
				available = new Set([...available, stage.alias ?? stage.collection]);
			}
			if (plan.op === "join" && plan.kind === "embed") {
				embedAliases.add(stage.alias ?? stage.collection);
			}
			knownAliases.add(stage.alias ?? stage.collection);
			// refresh currentScope pour que les subqueries dans
			// les prochains stages (where/having/pick.expr) puissent voir cet
			// alias join comme partie du scope outer.
			refreshCurrentScope();
		}
	}
	// group by requires pick.
	if (hasGroupStage && !query.stages.some((s) => s.type === "pick")) {
		throw new SnqlError(
			"'group by' exige un 'pick' — écris 'group by <champ> pick <champ>, <aggregate> as <alias>'",
			"lower_group_without_pick",
			groupKeySpans?.[0]
		);
	}
	return plan;
}

/**
 * Un `alias.field` en pick/where/sort où `alias` a été introduit par un `with`
 * en mode `embed` (one-to-many / many-to-many) n'a pas de valeur unique — le
 * codegen ne peut pas le traduire proprement. On lève ici une erreur explicite
 * plutôt que de laisser Postgres/Mongo remonter un message obscur.
 */
function checkNoEmbedAliasDeref(
	stage: Stage,
	embedAliases: ReadonlySet<string>
): void {
	if (embedAliases.size === 0) {
		return;
	}
	const referenced: (readonly string[])[] = [];
	switch (stage.type) {
		case "where":
		case "having":
			collectExprFields(stage.predicate, referenced);
			break;
		case "sort":
			for (const key of stage.keys) referenced.push(key.path);
			break;
		case "pick":
			for (const field of stage.fields) referenced.push(field.path);
			break;
		case "group":
			for (const key of stage.keys) referenced.push(key.path);
			break;
		case "limit":
			return;
	}
	for (const path of referenced) {
		if (path.length >= 2 && embedAliases.has(path[0] ?? "")) {
			throw new SnqlError(
				`'${path.join(".")}' pointe dans '${path[0]}' qui est un join one-to-many (embed array) — la ligne source a plusieurs valeurs, pas une. Utilise 'pick ${path[0]}' pour l'array complet, ou force 'with one ${path[0]} on …' si tu attends une seule row.`,
				"lower_embed_alias_deref"
			);
		}
	}
}

/**
 * Rejette un `path[0]` qui n'est ni l'alias source ni un alias `with` déjà vu.
 *
 * Sans cette garde, `find rna where r.upi = "x"` (sans `as r`) laisse le
 * codegen émettre `WHERE "r"."upi" = $1` que pg rejette avec
 * `missing FROM-clause entry for table "r"` — message obscur qui référence
 * un alias que l'utilisateur ne comprend pas (il pense avoir écrit une
 * colonne, pas une table).
 *
 * La règle est stricte : le nom de la collection elle-même (`users.email`
 * quand la source est `find users` sans alias) n'est PAS accepté — force
 * l'utilisateur à déclarer `as` explicitement ou à écrire le champ nu.
 * Cohérent avec la philosophie SNQL (pas de shortcut ambigu).
 *
 * Message dynamique : nomme l'alias fautif + suggère la correction avec le
 * bon nom (déclarer `as`, utiliser le champ nu, ou pointer vers un alias
 * with existant si le user a fait une typo légère).
 */
function checkAliasDefined(
	stage: Stage,
	knownAliases: ReadonlySet<string>,
	sourceColumns: ReadonlySet<string>,
	source: { readonly collection: string; readonly alias?: string }
): void {
	const referenced: {
		readonly path: readonly string[];
		readonly span: import("../lexer/token").Span;
	}[] = [];
	switch (stage.type) {
		case "where":
		case "having":
			collectExprFieldsWithSpans(stage.predicate, referenced);
			break;
		case "sort":
			for (const key of stage.keys) {
				referenced.push({ path: key.path, span: key.span });
			}
			break;
		case "pick":
			for (const field of stage.fields) {
				if (field.expr !== undefined) {
					collectExprFieldsWithSpans(field.expr, referenced);
				} else if (field.path.length > 0) {
					referenced.push({ path: field.path, span: field.span });
				}
			}
			break;
		case "group":
			for (const key of stage.keys) {
				referenced.push({ path: key.path, span: key.span });
			}
			break;
		case "with": {
			// `with X as y on a.b = c.d` :
			// - `localField` (LHS) réfère à la SOURCE — mêmes règles que where/sort.
			// - `foreignField` (RHS) réfère à la COLLECTION JOINTE dont l'alias
			//   est `stage.alias ?? stage.collection`. Seul ce nom est légal en
			//   préfixe — tout autre head est un alias inventé qui fuirait au
			//   codegen (`renderLeftJoin` / `renderEmbedSubquery`) avec
			//   `"y"."xyz"."field"` que pg rejette obscurément.
			if (stage.localField.length >= 2) {
				referenced.push({ path: stage.localField, span: stage.span });
			}
			if (stage.foreignField.length >= 2) {
				const joinAlias = stage.alias ?? stage.collection;
				const head = stage.foreignField[0] ?? "";
				if (head !== joinAlias) {
					throw new SnqlError(
						`'${head}' n'est pas l'alias de la collection jointe ('${joinAlias}') dans le foreignField '${stage.foreignField.join(".")}' — retire le préfixe : '${stage.foreignField.slice(1).join(".")}', ou écris '${joinAlias}.${stage.foreignField.slice(1).join(".")}'.`,
						"lower_unknown_alias",
						stage.span
					);
				}
			}
			break;
		}
		case "limit":
			return;
	}
	for (const { path, span } of referenced) {
		if (path.length < 2) continue;
		const head = path[0] ?? "";
		// L'ident de tête est valide s'il est un alias déclaré OU une colonne
		// document de la source (accès JSON `col.subfield`) — les deux sont
		// des utilisations légitimes de la syntaxe pointée.
		if (knownAliases.has(head) || sourceColumns.has(head)) continue;
		// correlated subquery — l'alias peut appartenir à un
		// scope outer (query englobante). Chercher du plus récent au plus
		// ancien (LIFO), les scopes plus proches ont priorité.
		if (
			outerScopeStack.length > 0 &&
			outerScopeStack.some((s) => s.aliases.has(head))
		) {
			continue;
		}
		const rest = path.slice(1).join(".");
		const suggestions: string[] = [];
		if (head === source.collection) {
			// Cas classique : `find users where users.email = ...` (SNQL ne
			// permet pas le nom de la collection comme préfixe implicite —
			// force la déclaration explicite ou le champ nu).
			suggestions.push(
				`déclare un alias explicite : 'find ${source.collection} as ${source.collection}'`
			);
			suggestions.push(`ou retire le préfixe : '${rest}'`);
		} else {
			suggestions.push(
				source.alias !== undefined
					? `l'alias source est '${source.alias}' — as-tu voulu écrire '${source.alias}.${rest}' ?`
					: `déclare l'alias source : 'find ${source.collection} as ${head}'`
			);
			suggestions.push(`ou retire le préfixe : '${rest}'`);
			if (knownAliases.size > 0) {
				const others = [...knownAliases].map((a) => `'${a}'`).join(", ");
				suggestions.push(`alias déjà déclarés : ${others}`);
			}
		}
		throw new SnqlError(
			`'${head}' n'est ni un alias déclaré ni une colonne de '${source.collection}' dans '${path.join(".")}' — ${suggestions.join(" ; ")}.`,
			"lower_unknown_alias",
			span
		);
	}
}

/**
 * Variante de [[collectExprFields]] qui capture aussi le span AST de chaque
 * référence — utilisée par [[checkAliasDefined]] pour porter le span source
 * SNQL dans le [[SnqlError]] (résolu côté frontend en squigglies + jump-to
 * dans l'éditeur, cf. Phase 3).
 */
function collectExprFieldsWithSpans(
	expr: Expr,
	out: {
		readonly path: readonly string[];
		readonly span: import("../lexer/token").Span;
	}[]
): void {
	switch (expr.type) {
		case "field":
			out.push({ path: expr.path, span: expr.span });
			return;
		case "literal":
			return;
		case "call":
			for (const arg of expr.args) collectExprFieldsWithSpans(arg, out);
			return;
		case "arith":
		case "compare":
		case "logical":
			collectExprFieldsWithSpans(expr.left, out);
			collectExprFieldsWithSpans(expr.right, out);
			return;
		case "not":
			collectExprFieldsWithSpans(expr.operand, out);
			return;
		case "in":
			collectExprFieldsWithSpans(expr.target, out);
			for (const value of expr.values) collectExprFieldsWithSpans(value, out);
			return;
		case "cast":
			collectExprFieldsWithSpans(expr.operand, out);
			return;
		case "object":
			for (const entry of expr.entries)
				collectExprFieldsWithSpans(entry.value, out);
			return;
		case "array":
			for (const item of expr.items) collectExprFieldsWithSpans(item, out);
			return;
		case "case":
			for (const branch of expr.branches) {
				collectExprFieldsWithSpans(branch.cond, out);
				collectExprFieldsWithSpans(branch.value, out);
			}
			collectExprFieldsWithSpans(expr.elseValue, out);
			return;
		case "windowCall":
			// collecte les field refs des args (ex: sum(x) over)
			// + partitionKeys + sortKeys — comptent tous pour l'alias-check.
			for (const arg of expr.args) collectExprFieldsWithSpans(arg, out);
			for (const p of expr.partitionKeys)
				out.push({ path: p, span: expr.span });
			for (const k of expr.sortKeys) out.push({ path: k.path, span: k.span });
			return;
		case "subquery":
		case "exists":
			// uncorrelated — la sub-query est self-contained, ne
			// contribue à aucun field ref de l'outer.
			return;
	}
}

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

/**
 * walker complet self-ref d'un binding CTE. Détecte le nom
 * `name` en tant que collection scannée n'importe où dans la Query : source,
 * with-join, where/having predicate, pick expr, subquery inline dans where/pick.
 * Sans ça, `let a = find b where c in (find a pick d)` passe silencieusement en
 * Mongo matérialisé et Postgres émet du SQL invalide. Cohérent graft.
 */
function bindingReferencesSelf(query: Query, name: string): boolean {
	return queryReferencesName(query, name);
}

function queryHasPickStage(query: Query): boolean {
	return query.stages.some((s) => s.type === "pick");
}

function queryHasLimitStage(query: Query): boolean {
	return query.stages.some((s) => s.type === "limit");
}

function queryReferencesName(query: Query, name: string): boolean {
	if (query.source.collection === name) return true;
	return query.stages.some((s) => stageReferencesName(s, name));
}

function stageReferencesName(
	stage: Query["stages"][number],
	name: string
): boolean {
	switch (stage.type) {
		case "where":
		case "having":
			return exprReferencesName(stage.predicate, name);
		case "pick":
			return stage.fields.some(
				(f) => f.expr !== undefined && exprReferencesName(f.expr, name)
			);
		case "with":
			return stage.collection === name;
		case "sort":
		case "limit":
		case "group":
			return false;
	}
}

function exprReferencesName(
	expr: import("../parser/ast").Expr,
	name: string
): boolean {
	switch (expr.type) {
		case "literal":
		case "field":
			return false;
		case "compare":
		case "logical":
		case "arith":
			return (
				exprReferencesName(expr.left, name) ||
				exprReferencesName(expr.right, name)
			);
		case "not":
			return exprReferencesName(expr.operand, name);
		case "in":
			return (
				exprReferencesName(expr.target, name) ||
				expr.values.some((v) => exprReferencesName(v, name))
			);
		case "call":
		case "windowCall":
			return expr.args.some((a) => exprReferencesName(a, name));
		case "cast":
			return exprReferencesName(expr.operand, name);
		case "object":
			return expr.entries.some((e) => exprReferencesName(e.value, name));
		case "array":
			return expr.items.some((i) => exprReferencesName(i, name));
		case "case":
			return (
				expr.branches.some(
					(b) =>
						exprReferencesName(b.cond, name) ||
						exprReferencesName(b.value, name)
				) || exprReferencesName(expr.elseValue, name)
			);
		case "subquery":
			return queryReferencesName(expr.query, name);
		case "exists":
			return exprReferencesName(expr.subquery, name);
	}
}

/**
 * `let x1 = ...; ... ; body` → LetPlan. Bindings lowered dans
 * l'ordre (chacun peut ref les précédents). Le body est lowered avec le set
 * de cte names — les mutations qui ciblent un cte name en écriture sont
 * refusées (`add into <cte>`, `update <cte>`, `remove from <cte>`).
 */
export function lowerLet(
	statement: import("../parser/ast").LetStatement,
	schema?: SchemaModel
): import("./plan").LetPlan {
	const seen = new Set<string>();
	const bindings: import("./plan").PlanCteBinding[] = statement.bindings.map(
		(b) => {
			if (seen.has(b.name)) {
				throw new SnqlError(
					`CTE '${b.name}' déclaré deux fois — chaque 'let' doit avoir un nom unique.`,
					"lower_let_duplicate_name",
					b.span
				);
			}
			// refus shadowing CTE vs table du SchemaModel.
			// Gated sur schema — sans schema (mode lib / tests unitaires isolés) skip.
			// (partial) : le check est engine-agnostique (fires sur
			// tout SchemaModel avec la collection en question). Pour Mongo sans
			// schema disponible au lower (introspection non cachée), le shadow-check
			// silently skip — divergence potentielle PG throw / Mongo empty rowset.
			// Fix complet reporté : listCollections() cache au bootstrap CLI.
			if (schema && schema.collections.some((c) => c.name === b.name)) {
				throw new SnqlError(
					`CTE '${b.name}' masque la table '${b.name}' — renomme (ex: 'active_${b.name}', '${b.name}_view').`,
					"lower_let_shadows_collection",
					b.span
				);
			}
			if (b.kind === "recursive") {
				if (!queryHasPickStage(b.base)) {
					throw new SnqlError(
						`'let rec ${b.name}' base doit expliciter 'pick <cols>' (shape définie).`,
						"lower_let_rec_pick_required",
						b.base.span
					);
				}
				if (!queryHasPickStage(b.step)) {
					throw new SnqlError(
						`'let rec ${b.name}' step doit expliciter 'pick <cols>' (shape définie).`,
						"lower_let_rec_pick_required",
						b.step.span
					);
				}
				if (queryReferencesName(b.base, b.name)) {
					throw new SnqlError(
						`'let rec ${b.name}' base ne peut pas se référencer (non terminable). Déplace le self-ref dans le step.`,
						"lower_let_rec_base_self_reference",
						b.base.span
					);
				}
				if (!queryReferencesName(b.step, b.name)) {
					throw new SnqlError(
						`'let rec ${b.name}' step doit référencer '${b.name}' au moins une fois. Sinon utilise 'let' simple.`,
						"lower_let_rec_step_no_self_reference",
						b.step.span
					);
				}
				seen.add(b.name);
				return {
					kind: "recursive",
					name: b.name,
					base: lower(b.base, schema),
					step: lower(b.step, schema)
				};
			}
			// graft : `let a = find a` émet du SQL invalide.
			// détecter au lower avec hint vers `let rec`. Couvre source + with-join ;
			// walker complet (subqueries) arrive avec (G12).
			if (bindingReferencesSelf(b.query, b.name)) {
				throw new SnqlError(
					`CTE '${b.name}' se référence lui-même — utilise 'let rec ${b.name} = base union all step;' pour un CTE récursif.`,
					"lower_let_self_reference_without_rec",
					b.span
				);
			}
			seen.add(b.name);
			return { kind: "plain", name: b.name, plan: lower(b.query, schema) };
		}
	);
	const cteNames = seen;
	const recursiveNames = new Set(
		statement.bindings.filter((b) => b.kind === "recursive").map((b) => b.name)
	);
	// Refuse un mutation body qui cible un CTE (write-to-view interdit).
	if (statement.body.operation !== "select") {
		const target = statement.body.collection;
		if (cteNames.has(target)) {
			throw new SnqlError(
				`Écriture sur le CTE '${target}' interdite — un CTE est immutable (view). Cible une vraie table.`,
				"lower_let_write_to_cte",
				statement.body.span
			);
		}
	} else if (
		recursiveNames.has(statement.body.source.collection) &&
		!queryHasLimitStage(statement.body)
	) {
		// Garde-fou OOM : `find <rec_cte>` direct sans limit N accumule sans borne.
		// Force l'user à borner explicitement.
		throw new SnqlError(
			`'find ${statement.body.source.collection}' sur CTE récursif requiert 'limit N' explicite (garde-fou OOM).`,
			"lower_let_rec_body_unbounded",
			statement.body.span
		);
	}
	const body =
		statement.body.operation === "select"
			? lower(statement.body, schema)
			: lowerMutation(statement.body, schema);
	return { op: "let", bindings, body };
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

export function lowerMutation(
	statement: InsertStatement | UpdateStatement | DeleteStatement,
	schema?: SchemaModel
): MutationPlan {
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
				statement.assignments[i]!.value,
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
 * Construit `sourceColumns` depuis le schéma — retourne `null` (permissif)
 * quand la source n'est pas dans le schéma ou n'a pas de fields listés.
 * Partagé entre [[lower]] (reads) et [[lowerMutation]] (writes).
 */
function resolveSourceColumns(
	schema: SchemaModel | undefined,
	collection: string
): ReadonlySet<string> | null {
	if (schema === undefined) return null;
	const src = schema.collections.find((c) => c.name === collection);
	if (src === undefined || src.fields.length === 0) return null;
	return new Set(src.fields.map((f) => f.name));
}

/**
 * Variante mutation-friendly de [[checkAliasDefined]] : les mutations n'ont
 * pas d'alias déclaré, donc tout `path.length ≥ 2` dont le head n'est pas
 * une colonne document est un alias fantôme. Descend récursivement dans
 * les sous-expressions (arith, call, compare, and/or/not/in).
 *
 * `allowedAliases` autorise en plus (a) l'alias source d'un
 * `update t as a` et (b) chaque alias de `with one X` joint. Un head qui
 * n'est ni une col source, ni le nom de la table, ni un alias autorisé =
 * fantôme.
 */
function checkExprPathsAgainstColumns(
	expr: Expr,
	sourceColumns: ReadonlySet<string>,
	collection: string,
	allowedAliases: ReadonlySet<string> = new Set()
): void {
	const referenced: {
		readonly path: readonly string[];
		readonly span: import("../lexer/token").Span;
	}[] = [];
	collectExprFieldsWithSpans(expr, referenced);
	for (const { path, span } of referenced) {
		if (path.length === 1) {
			// Ident nu (`col`) : doit être une col source. Détecte les typos type
			// `remove from artist where bad_col = 1` qui passait silencieux jusqu'à
			// runtime (PG remontait alors `column "bad_col" does not exist`, cryptique).
			const col = path[0] ?? "";
			if (sourceColumns.has(col)) continue;
			if (allowedAliases.has(col)) continue;
			const closest = closestColumnHint(col, sourceColumns);
			throw new SnqlError(
				`'${col}' n'est pas une colonne de '${collection}'${closest}.`,
				"lower_unknown_column",
				span
			);
		}
		const head = path[0] ?? "";
		if (sourceColumns.has(head)) continue;
		if (allowedAliases.has(head)) continue;
		const rest = path.slice(1).join(".");
		const suggestion =
			head === collection
				? `retire le préfixe : '${rest}' (les mutations ne portent pas d'alias)`
				: `retire le préfixe '${head}' : '${rest}' (les mutations ne portent pas d'alias — écris le champ nu de '${collection}')`;
		throw new SnqlError(
			`'${head}' n'est pas une colonne de '${collection}' dans '${path.join(".")}' — ${suggestion}.`,
			"lower_unknown_alias",
			span
		);
	}
}

/**
 * Suggère la col la plus proche via Levenshtein simple — évite une phrase
 * vide et guide l'user vers le typo probable. Skip si aucune col n'est
 * proche (distance > 2 sur tous les candidats).
 */
function closestColumnHint(
	typed: string,
	sourceColumns: ReadonlySet<string>
): string {
	let best: string | null = null;
	let bestDist = 3;
	for (const c of sourceColumns) {
		const d = levenshtein(typed, c);
		if (d < bestDist) {
			bestDist = d;
			best = c;
		}
	}
	return best !== null ? ` — voulais-tu dire '${best}' ?` : "";
}

function levenshtein(a: string, b: string): number {
	const m = a.length;
	const n = b.length;
	if (m === 0) return n;
	if (n === 0) return m;
	const dp: number[] = new Array(n + 1);
	for (let j = 0; j <= n; j += 1) dp[j] = j;
	for (let i = 1; i <= m; i += 1) {
		let prev = dp[0]!;
		dp[0] = i;
		for (let j = 1; j <= n; j += 1) {
			const tmp = dp[j]!;
			dp[j] =
				a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j]!, dp[j - 1]!);
			prev = tmp;
		}
	}
	return dp[n]!;
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
 * walker AST — true ssi l'expression contient au moins un call
 * dont le kind du registre est `aggregate`. Utilisé pour détecter en amont
 * qu'un pick doit basculer en op='aggregate' (avant lowerField).
 */
function containsAggregateAst(expr: Expr): boolean {
	if (expr.type === "call") {
		const entry = SNQL_FUNCTIONS.get(expr.name);
		if (entry?.kind === "aggregate" || entry?.kind === "aggregateMulti")
			return true;
		for (const arg of expr.args) if (containsAggregateAst(arg)) return true;
		return false;
	}
	switch (expr.type) {
		case "literal":
		case "field":
			return false;
		case "compare":
		case "logical":
		case "arith":
			return (
				containsAggregateAst(expr.left) || containsAggregateAst(expr.right)
			);
		case "not":
			return containsAggregateAst(expr.operand);
		case "in":
			return (
				containsAggregateAst(expr.target) ||
				expr.values.some(containsAggregateAst)
			);
		case "cast":
			return containsAggregateAst(expr.operand);
		case "object":
			return expr.entries.some((e) => containsAggregateAst(e.value));
		case "array":
			return expr.items.some(containsAggregateAst);
		case "case":
			return (
				expr.branches.some(
					(b) => containsAggregateAst(b.cond) || containsAggregateAst(b.value)
				) || containsAggregateAst(expr.elseValue)
			);
		case "windowCall":
			// windowCall n'est PAS un aggregate — pick avec
			// windowCall reste op='project' (pas 'aggregate').
			return false;
		case "subquery":
		case "exists":
			// uncorrelated — aggregates dans la subquery ne
			// contribuent pas au pick outer.
			return false;
	}
}

/**
 * span du premier aggregate AST rencontré (helper d'erreur).
 */
function firstAggregateSpanAst(
	expr: Expr
): import("../lexer/token").Span | undefined {
	if (expr.type === "call") {
		const entry = SNQL_FUNCTIONS.get(expr.name);
		if (entry?.kind === "aggregate" || entry?.kind === "aggregateMulti")
			return expr.span;
		for (const arg of expr.args) {
			const s = firstAggregateSpanAst(arg);
			if (s !== undefined) return s;
		}
		return undefined;
	}
	switch (expr.type) {
		case "literal":
		case "field":
			return undefined;
		case "compare":
		case "logical":
		case "arith":
			return (
				firstAggregateSpanAst(expr.left) ?? firstAggregateSpanAst(expr.right)
			);
		case "not":
			return firstAggregateSpanAst(expr.operand);
		case "in": {
			const t = firstAggregateSpanAst(expr.target);
			if (t !== undefined) return t;
			for (const v of expr.values) {
				const s = firstAggregateSpanAst(v);
				if (s !== undefined) return s;
			}
			return undefined;
		}
		case "cast":
			return firstAggregateSpanAst(expr.operand);
		case "object":
			for (const e of expr.entries) {
				const s = firstAggregateSpanAst(e.value);
				if (s !== undefined) return s;
			}
			return undefined;
		case "array":
			for (const i of expr.items) {
				const s = firstAggregateSpanAst(i);
				if (s !== undefined) return s;
			}
			return undefined;
		case "case": {
			for (const b of expr.branches) {
				const s =
					firstAggregateSpanAst(b.cond) ?? firstAggregateSpanAst(b.value);
				if (s !== undefined) return s;
			}
			return firstAggregateSpanAst(expr.elseValue);
		}
		case "windowCall":
			// windowCall n'est PAS un aggregate.
			return undefined;
		case "subquery":
		case "exists":
			// uncorrelated — pas de span aggregate pour outer.
			return undefined;
	}
}

/**
 * valide un field expr d'un pick op='aggregate'. Applique
 * les 8 refus positions internes + bare-field-hors-agg. Descente contextuelle :
 *  - Dans les args d'un aggregate direct : agg nested REFUS, fields bare OK.
 *  - Dans un scalar wrapper (coalesce/greatest/least/cast/arith/compare) :
 *    agg comme arg direct OK, fields bare REFUS (sauf s'ils matchent un
 * groupKey — accepté).
 *  - Dans if/case cond OU branch : agg REFUS (patterns SQL canoniques
 *    sum(if(cond,x,0))). Fields bare toujours REFUS hors agg direct.
 *  - Object/array literal : agg REFUS (scalar wrappers only).
 */
function validateAggregatePickFieldAst(
	expr: Expr,
	groupKeySet?: ReadonlySet<string>,
	sourceAlias?: string
): void {
	validateInAggWrapperAst(expr, false, groupKeySet, sourceAlias);
}

function validateHavingAst(
	expr: Expr,
	groupKeySet?: ReadonlySet<string>,
	sourceAlias?: string
): void {
	validateInAggWrapperAst(expr, false, groupKeySet, sourceAlias);
}

function validateInAggWrapperAst(
	expr: Expr,
	insideAgg: boolean,
	groupKeySet?: ReadonlySet<string>,
	sourceAlias?: string
): void {
	if (expr.type === "call") {
		const entry = SNQL_FUNCTIONS.get(expr.name);
		if (entry?.kind === "aggregate" || entry?.kind === "aggregateMulti") {
			// Aggregate détecté. Refus si déjà dans un agg (nested).
			if (insideAgg) {
				throw new SnqlError(
					`Aggregate imbriqué '${expr.name}(...)' — window functions arrivent `,
					"lower_agg_nested",
					expr.span
				);
			}
			for (const arg of expr.args)
				validateInAggWrapperAst(arg, true, groupKeySet, sourceAlias);
			return;
		}
		if (expr.name === "if" && expr.args.length === 3) {
			const condSpan = firstAggregateSpanAst(expr.args[0]!);
			if (condSpan !== undefined) {
				throw new SnqlError(
					"'if(cond, …, …)' : la cond doit être scalaire per-row, pas un aggregate global",
					"lower_agg_in_if_cond",
					condSpan
				);
			}
			validateInAggWrapperAst(
				expr.args[0]!,
				insideAgg,
				groupKeySet,
				sourceAlias
			);
			for (const branchIdx of [1, 2]) {
				const branch = expr.args[branchIdx]!;
				const branchAggSpan = firstAggregateSpanAst(branch);
				if (branchAggSpan !== undefined) {
					throw new SnqlError(
						`Aggregate dans une branche de 'if' — utilise le pattern canonique 'sum(if(cond, x, 0))' (déplace le if DANS l'agg)`,
						"lower_agg_in_if_branch",
						branchAggSpan
					);
				}
				validateInAggWrapperAst(branch, insideAgg, groupKeySet, sourceAlias);
			}
			return;
		}
		for (const arg of expr.args)
			validateInAggWrapperAst(arg, insideAgg, groupKeySet, sourceAlias);
		return;
	}
	switch (expr.type) {
		case "literal":
			return;
		case "field": {
			if (!insideAgg) {
				const strippedPath = stripAlias(expr.path, sourceAlias).join(".");
				if (groupKeySet !== undefined && groupKeySet.has(strippedPath)) {
					return;
				}
				const pathStr = expr.path.join(".");
				throw new SnqlError(
					groupKeySet !== undefined
						? `Champ '${pathStr}' n'est ni une clé de group by ni dans un aggregate — ajoute '${pathStr}' à group by ou wrappe en min(${pathStr})`
						: `Champ '${pathStr}' hors argument d'un aggregate — utilise 'group by ${pathStr}' ou wrappe en min(${pathStr})`,
					"lower_bare_field_in_agg_scalar_wrapper",
					expr.span
				);
			}
			return;
		}
		case "compare":
		case "logical":
		case "arith":
			validateInAggWrapperAst(expr.left, insideAgg, groupKeySet, sourceAlias);
			validateInAggWrapperAst(expr.right, insideAgg, groupKeySet, sourceAlias);
			return;
		case "not":
			validateInAggWrapperAst(
				expr.operand,
				insideAgg,
				groupKeySet,
				sourceAlias
			);
			return;
		case "in":
			validateInAggWrapperAst(expr.target, insideAgg, groupKeySet, sourceAlias);
			for (const v of expr.values)
				validateInAggWrapperAst(v, insideAgg, groupKeySet, sourceAlias);
			return;
		case "cast":
			validateInAggWrapperAst(
				expr.operand,
				insideAgg,
				groupKeySet,
				sourceAlias
			);
			return;
		case "object": {
			for (const e of expr.entries) {
				const aggSpan = firstAggregateSpanAst(e.value);
				if (aggSpan !== undefined) {
					throw new SnqlError(
						"Aggregate dans un object literal — object de scalaires uniquement (agg direct au top-level du pick)",
						"lower_agg_in_object_literal",
						aggSpan
					);
				}
				validateInAggWrapperAst(e.value, insideAgg, groupKeySet, sourceAlias);
			}
			return;
		}
		case "array": {
			for (const item of expr.items) {
				const aggSpan = firstAggregateSpanAst(item);
				if (aggSpan !== undefined) {
					throw new SnqlError(
						"Aggregate dans un array literal — array de scalaires uniquement (agg direct au top-level du pick)",
						"lower_agg_in_array_literal",
						aggSpan
					);
				}
				validateInAggWrapperAst(item, insideAgg, groupKeySet, sourceAlias);
			}
			return;
		}
		case "case": {
			for (const b of expr.branches) {
				const condSpan = firstAggregateSpanAst(b.cond);
				if (condSpan !== undefined) {
					throw new SnqlError(
						"'case { cond -> … }' : la cond doit être scalaire per-row, pas un aggregate global",
						"lower_agg_in_case_cond",
						condSpan
					);
				}
				validateInAggWrapperAst(b.cond, insideAgg, groupKeySet, sourceAlias);
				const branchSpan = firstAggregateSpanAst(b.value);
				if (branchSpan !== undefined) {
					throw new SnqlError(
						"Aggregate dans une branche de 'case' — utilise le pattern canonique 'sum(if(cond, x, 0))' (déplace le if DANS l'agg)",
						"lower_agg_in_case_branch",
						branchSpan
					);
				}
				validateInAggWrapperAst(b.value, insideAgg, groupKeySet, sourceAlias);
			}
			const elseSpan = firstAggregateSpanAst(expr.elseValue);
			if (elseSpan !== undefined) {
				throw new SnqlError(
					"Aggregate dans la branche 'else' de 'case' — utilise le pattern canonique 'sum(if(cond, x, 0))'",
					"lower_agg_in_case_branch",
					elseSpan
				);
			}
			validateInAggWrapperAst(
				expr.elseValue,
				insideAgg,
				groupKeySet,
				sourceAlias
			);
			return;
		}
	}
}

/**
 * retourne le span du premier `call` d'un aggregate rencontré,
 * ou undefined si le PlanExpr n'en contient aucun. Utilisé par les guards
 * `lower_agg_in_*` pour émettre un message actionnable pointant sur l'agg
 * fautif (pas sur le stage entier).
 */
export function firstAggregateSpan(
	expr: PlanExpr
): import("../lexer/token").Span | undefined {
	if (expr.kind === "call") {
		const entry = SNQL_FUNCTIONS.get(expr.name);
		if (entry?.kind === "aggregate" || entry?.kind === "aggregateMulti")
			return expr.span;
		for (const arg of expr.args) {
			const s = firstAggregateSpan(arg);
			if (s !== undefined) return s;
		}
		return undefined;
	}
	switch (expr.kind) {
		case "literal":
		case "field":
			return undefined;
		case "compare":
		case "and":
		case "or":
		case "arith":
			return firstAggregateSpan(expr.left) ?? firstAggregateSpan(expr.right);
		case "not":
		case "isNull":
			return firstAggregateSpan(expr.operand);
		case "in": {
			const t = firstAggregateSpan(expr.target);
			if (t !== undefined) return t;
			for (const v of expr.values) {
				const s = firstAggregateSpan(v);
				if (s !== undefined) return s;
			}
			return undefined;
		}
		case "cast":
			return firstAggregateSpan(expr.operand);
		case "object":
			for (const e of expr.entries) {
				const s = firstAggregateSpan(e.value);
				if (s !== undefined) return s;
			}
			return undefined;
		case "array":
			for (const i of expr.items) {
				const s = firstAggregateSpan(i);
				if (s !== undefined) return s;
			}
			return undefined;
		case "case": {
			for (const b of expr.branches) {
				const s = firstAggregateSpan(b.cond) ?? firstAggregateSpan(b.value);
				if (s !== undefined) return s;
			}
			return firstAggregateSpan(expr.elseValue);
		}
		case "windowCall":
			for (const arg of expr.args) {
				const s = firstAggregateSpan(arg);
				if (s !== undefined) return s;
			}
			return undefined;
		case "subquery":
		case "exists":
			return undefined;
	}
}

/**
 * Refuse un aggregate dans une position non-projection. Émet le code d'erreur
 * spécifique à la position (where/set/delete/…) avec un hint actionnable
 * pointant vers le pattern SQL canonique.
 *
 * Ordre CRITIQUE dans un contexte write : appeler AVANT `assertNoCallInWrite`
 * — sinon un `set y = count(*)` remonte le générique `lower_call_null_write`
 * au lieu du précis `lower_agg_in_set` (piège UX documenté).
 */
function refuseAggregateInPosition(
	expr: PlanExpr,
	code: string,
	message: string
): void {
	const span = firstAggregateSpan(expr);
	if (span === undefined) return;
	throw new SnqlError(message, code, span);
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
			clause.action.assignments[i]!.value,
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
				const col = tail[0]!;
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
	const sourceQuery = statement.sourceQuery!;
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
	available: ReadonlySet<string> | null,
	sourceColumns: ReadonlySet<string> | null
): void {
	if (available === null) {
		return;
	}
	// sort après pick peut référencer une colonne source droppée
	// par le pick — aligné avec SQL (ORDER BY accepte les colonnes de FROM même
	// non-sélectionnées). En Mongo, cette pattern reste indéfinie côté runtime
	// (divergence documentée) ; PG l'accepte nativement.
	if (stage.type === "sort") {
		if (sourceColumns === null) return;
		for (const key of stage.keys) {
			// Ident préfixé (path.length > 1, ex: `ar.name`) : le pick a projeté
			// le dernier segment (`name`) comme col output — check contre ça.
			// Sans ce fallback, un `sort ar.name` après `pick a.title, ar.name`
			// refuse à tort car path[0]='ar' n'est pas une col de la source.
			const column =
				key.path.length > 1
					? (key.path[key.path.length - 1] ?? "")
					: (key.path[0] ?? "");
			if (!available.has(column) && !sourceColumns.has(column)) {
				throw new SnqlError(
					`La colonne '${column}' n'existe pas dans le pick précédent ni dans la source — vérifie l'orthographe ou ajoute-la au pick.`,
					"lower_column_unavailable"
				);
			}
		}
		return;
	}
	const referenced: (readonly string[])[] = [];
	switch (stage.type) {
		case "where":
		case "having":
			collectExprFields(stage.predicate, referenced);
			break;
		case "pick":
			for (const field of stage.fields) {
				if (field.expr !== undefined) {
					collectExprFields(field.expr, referenced);
				} else {
					referenced.push(field.path);
				}
			}
			break;
		case "group":
			for (const key of stage.keys) {
				referenced.push(key.path);
			}
			break;
		case "with":
			referenced.push(stage.localField);
			break;
		case "limit":
			return;
	}
	for (const path of referenced) {
		// Même règle qu'au sort : path préfixé (`ar.name`) → check contre le
		// dernier segment (col output après pick). Une col nue conserve
		// l'ancien comportement.
		const column =
			path.length > 1 ? (path[path.length - 1] ?? "") : (path[0] ?? "");
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
		case "call":
			for (const arg of expr.args) collectExprFields(arg, out);
			return;
		case "arith":
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
		case "cast":
			collectExprFields(expr.operand, out);
			return;
		case "object":
			for (const entry of expr.entries) collectExprFields(entry.value, out);
			return;
		case "array":
			for (const item of expr.items) collectExprFields(item, out);
			return;
		case "case":
			for (const branch of expr.branches) {
				collectExprFields(branch.cond, out);
				collectExprFields(branch.value, out);
			}
			collectExprFields(expr.elseValue, out);
			return;
		case "windowCall":
			for (const arg of expr.args) collectExprFields(arg, out);
			for (const p of expr.partitionKeys) out.push(p);
			for (const k of expr.sortKeys) out.push(k.path);
			return;
		case "subquery":
		case "exists":
			// uncorrelated — pas de field ref outer.
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
	sourceCollection: string,
	sourceAlias: string | undefined,
	schema: SchemaModel | undefined,
	groupKeys?: readonly (readonly string[])[]
): LogicalPlan {
	switch (stage.type) {
		case "where": {
			assertNoBareCallPredicate(stage.predicate);
			const predicate = lowerExpr(stage.predicate);
			refuseAggregateInPosition(
				predicate,
				"lower_agg_in_where",
				"Aggregate dans 'where' non supporté — utilise 'having' après 'group by' pour filtrer les groupes"
			);
			return { op: "filter", input, predicate };
		}
		case "pick": {
			const fields = stage.fields.map(lowerField);
			assertUniqueProjectionKeys(fields);
			const hasAggregate = stage.fields.some(
				(f) => f.expr !== undefined && containsAggregateAst(f.expr)
			);
			// window fns et aggregates dans le même pick sont
			// exclusifs (2 stages logiques différents — un ORDER BY dans window
			// puis un fold aggregate n'a pas de sémantique naturelle).
			const hasWindowCall = stage.fields.some(
				(f) => f.expr !== undefined && containsWindowCallAst(f.expr)
			);
			if (hasAggregate && hasWindowCall) {
				throw new SnqlError(
					"Mix window function + aggregate dans le même pick non supporté — sépare en deux queries ou utilise une sub-query",
					"lower_window_agg_mix",
					stage.span
				);
			}
			if (hasWindowCall && groupKeys !== undefined) {
				throw new SnqlError(
					"Window function dans un pick après 'group by' non supporté — le group by change le shape des rows sur lequel la window opère",
					"lower_window_after_group",
					stage.span
				);
			}
			// DISTINCT / DISTINCT ON validations.
			if (
				(stage.unique === true || stage.distinctOnKeys !== undefined) &&
				groupKeys !== undefined
			) {
				throw new SnqlError(
					"'pick unique' et 'group by' non combinables — les deux dédup mais différemment ; utilise l'un ou l'autre",
					"lower_unique_with_group",
					stage.span
				);
			}
			if (
				(stage.unique === true || stage.distinctOnKeys !== undefined) &&
				hasAggregate
			) {
				throw new SnqlError(
					"'pick unique' avec aggregate non supporté — l'aggregate produit déjà une row par groupe, unique est redondant ou ambigu",
					"lower_unique_with_aggregate",
					stage.span
				);
			}
			if (
				(stage.unique === true || stage.distinctOnKeys !== undefined) &&
				hasWindowCall
			) {
				throw new SnqlError(
					"'pick unique' avec window function non supporté — les deux opèrent sur des rows différentes ; sépare en deux queries",
					"lower_unique_with_window",
					stage.span
				);
			}
			// groupKeys are alias-stripped already. Build the lookup set from them.
			const groupKeySet =
				groupKeys !== undefined
					? new Set(groupKeys.map((k) => k.join(".")))
					: undefined;
			if (hasAggregate || groupKeys !== undefined) {
				for (const f of stage.fields) {
					if (f.expr !== undefined) {
						validateAggregatePickFieldAst(f.expr, groupKeySet, sourceAlias);
					} else if (f.path.length > 0) {
						// Strip source alias so `u.year` matches groupKey `year`.
						const strippedPath = stripAlias(f.path, sourceAlias).join(".");
						if (groupKeySet !== undefined && groupKeySet.has(strippedPath)) {
							continue;
						}
						const pathStr = f.path.join(".");
						throw new SnqlError(
							groupKeys !== undefined
								? `Champ '${pathStr}' n'est ni une clé de group by ni dans un aggregate — ajoute '${pathStr}' à group by ou wrappe en min(${pathStr})`
								: `Champ '${pathStr}' hors argument d'un aggregate — utilise 'group by ${pathStr}' ou wrappe en min(${pathStr})`,
							"planner_agg_bare_field_needs_group",
							f.span
						);
					}
				}
				return groupKeys !== undefined
					? { op: "aggregate", input, fields, groupKeys }
					: { op: "aggregate", input, fields };
			}
			// distinctOnKeys — strip source alias sur les paths
			// (alignés fields projetés + sort keys). Puis check chaque key
			// APPARAIT dans les fields projetés (parité PG DISTINCT ON — sinon
			// la key n'a pas de valeur à comparer post-projection).
			const strippedDistinctKeys =
				stage.distinctOnKeys !== undefined
					? stage.distinctOnKeys.map((k) => stripAlias(k, sourceAlias))
					: undefined;
			if (strippedDistinctKeys !== undefined) {
				const fieldOutputNames = new Set(
					fields.map((f) => f.alias ?? f.path[f.path.length - 1] ?? "")
				);
				for (const [i, k] of strippedDistinctKeys.entries()) {
					const keyStr = k.join(".");
					// La key peut matcher soit un output alias, soit le dernier
					// segment d'un field path projeté.
					const lastSeg = k[k.length - 1] ?? "";
					if (!fieldOutputNames.has(keyStr) && !fieldOutputNames.has(lastSeg)) {
						throw new SnqlError(
							`'unique on (${keyStr})' — key '${keyStr}' absente des fields projetés ; ajoute '${keyStr}' à pick ou retire-la de 'on'`,
							"lower_unique_on_key_not_projected",
							stage.distinctOnKeys![i]!.length > 0 ? stage.span : stage.span
						);
					}
				}
			}
			return {
				op: "project",
				input,
				fields,
				...(stage.unique === true ? { unique: true as const } : {}),
				...(strippedDistinctKeys !== undefined
					? { distinctOnKeys: strippedDistinctKeys }
					: {})
			};
		}
		case "sort":
			return { op: "sort", input, keys: stage.keys.map(lowerSortKey) };
		case "limit":
			return stage.offset !== undefined
				? { op: "limit", input, count: stage.count, offset: stage.offset }
				: { op: "limit", input, count: stage.count };
		case "with": {
			// localField vient de la source (strip son alias), foreignField de la collection jointe.
			const localField = stripAlias(stage.localField, sourceAlias);
			const foreignField = stripAlias(
				stage.foreignField,
				stage.alias ?? stage.collection
			);
			const kind = resolveJoinKind(
				sourceCollection,
				stage.collection,
				localField,
				foreignField,
				stage.multiplicity,
				schema
			);
			return {
				op: "join",
				input,
				collection: stage.collection,
				as: stage.alias ?? stage.collection,
				localField,
				foreignField,
				kind
			};
		}
		case "group":
		case "having":
			// ces stages sont consommés dans la boucle lower()
			// n'arrivent jamais ici (defense-in-depth pour l'exhaustivité TS).
			throw new SnqlError(
				`Stage '${stage.type}' consommé en amont — bug lower/parser sync`,
				"lower_stage_leaked"
			);
	}
}

/**
 * Choix de la multiplicité d'un join. Ordre :
 * 1. Mot-clé utilisateur (`with one X` / `with many X`) — override total.
 * 2. Inférence via [[SchemaModel]] : cherche une relation matchant
 *    (source, joined, localField, foreignField) dans les deux orientations,
 *    lit le `kind`, l'oriente depuis la source. many-to-one/one-to-one → `join`,
 *    one-to-many/many-to-many → `embed`.
 * 3. Fallback `embed` — comportement historique, ne casse pas l'existant quand
 *    l'introspection n'a pas tourné ou n'a pas trouvé la FK.
 */
function resolveJoinKind(
	sourceCollection: string,
	joinedCollection: string,
	localField: readonly string[],
	foreignField: readonly string[],
	multiplicity: "one" | "many" | undefined,
	schema: SchemaModel | undefined
): "embed" | "join" {
	if (multiplicity === "one") {
		return "join";
	}
	if (multiplicity === "many") {
		return "embed";
	}
	if (schema === undefined) {
		return "embed";
	}
	for (const rel of schema.relations) {
		const oriented = orientRelation(
			rel,
			sourceCollection,
			joinedCollection,
			localField,
			foreignField
		);
		if (oriented !== undefined) {
			return oriented === "one-to-one" || oriented === "many-to-one"
				? "join"
				: "embed";
		}
	}
	return "embed";
}

/**
 * Une relation matche notre join ssi ses collections et fields correspondent
 * dans l'une des deux orientations. Retourne le `kind` **du POV de la source**
 * (inversé si la relation est écrite dans l'autre sens).
 */
function orientRelation(
	rel: Relation,
	source: string,
	joined: string,
	localField: readonly string[],
	foreignField: readonly string[]
): RelationKind | undefined {
	if (
		rel.from.collection === source &&
		rel.to.collection === joined &&
		fieldsEqual(rel.from.fields, localField) &&
		fieldsEqual(rel.to.fields, foreignField)
	) {
		return rel.kind;
	}
	if (
		rel.to.collection === source &&
		rel.from.collection === joined &&
		fieldsEqual(rel.to.fields, localField) &&
		fieldsEqual(rel.from.fields, foreignField)
	) {
		return invertKind(rel.kind);
	}
	return undefined;
}

function invertKind(kind: RelationKind): RelationKind {
	if (kind === "many-to-one") return "one-to-many";
	if (kind === "one-to-many") return "many-to-one";
	// one-to-one et many-to-many sont symétriques.
	return kind;
}

function fieldsEqual(a: readonly string[], b: readonly string[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i += 1) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

function lowerField(field: FieldSelection): PlanProjectField {
	if (field.expr !== undefined) {
		// Contrat vérifié au parser mais on double-check ici (l'IR est le contrat).
		if (field.alias === undefined) {
			throw new SnqlError(
				"Une expression projetée exige un alias",
				"lower_pick_expr_alias"
			);
		}
		return { path: [], expr: lowerExpr(field.expr), alias: field.alias };
	}
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
	// Le span AST est propagé sur chaque node plan → Phase 3a-b (traçabilité
	// erreurs Postgres → source SNQL). Pour `compare`/`logical`/`not`/`in`,
	// on garde le span du node AST source ; `lowerCompare` peut le remplacer
	// par le span joint quand il canonicalise (isNull, flip d'opérandes).
	switch (expr.type) {
		case "literal":
			return {
				kind: "literal",
				value: literalToValue(expr.value),
				span: expr.span
			};
		case "field":
			return { kind: "field", path: expr.path, span: expr.span };
		case "compare":
			return lowerCompare(
				expr.operator,
				lowerExpr(expr.left),
				lowerExpr(expr.right),
				expr.span
			);
		case "logical":
			return expr.operator === "and"
				? {
						kind: "and",
						left: lowerExpr(expr.left),
						right: lowerExpr(expr.right),
						span: expr.span
					}
				: {
						kind: "or",
						left: lowerExpr(expr.left),
						right: lowerExpr(expr.right),
						span: expr.span
					};
		case "not":
			return { kind: "not", operand: lowerExpr(expr.operand), span: expr.span };
		case "in": {
			// `x in (subquery)` — validate subquery a exactement
			// 1 output field (parité PG `x IN (SELECT y FROM t)`).
			const isSubqueryVariant =
				expr.values.length === 1 && expr.values[0]?.type === "subquery";
			if (isSubqueryVariant) {
				const subExpr = expr.values[0]! as Expr & { type: "subquery" };
				const pickStage = subExpr.query.stages.find((s) => s.type === "pick");
				if (pickStage === undefined || pickStage.type !== "pick") {
					throw new SnqlError(
						"'in (subquery)' — la sub-query doit avoir un 'pick' avec exactement 1 field",
						"lower_in_subquery_no_pick",
						expr.values[0]!.span
					);
				}
				if (pickStage.fields.length !== 1) {
					throw new SnqlError(
						`'in (subquery)' — la sub-query doit projeter exactement 1 field, reçu ${pickStage.fields.length}`,
						"lower_in_subquery_arity",
						expr.values[0]!.span
					);
				}
			}
			return {
				kind: "in",
				target: lowerExpr(expr.target),
				values: expr.values.map(lowerExpr),
				span: expr.span
			};
		}
		case "arith":
			return {
				kind: "arith",
				op: expr.operator,
				left: lowerExpr(expr.left),
				right: lowerExpr(expr.right),
				span: expr.span
			};
		case "call":
			return lowerCall(expr);
		case "windowCall":
			return lowerWindowCall(expr);
		case "subquery": {
			// lower récursif. Le `lower()` détecte le contexte
			// non-null (currentScope !== null) et pousse automatiquement le
			// scope outer sur outerScopeStack, permettant à la subquery de
			// résoudre les alias corrélés via checkAliasDefined.
			// Le schema est propagé via moduleSchema (module state).
			const subPlan = lower(expr.query, moduleSchema);
			return { kind: "subquery", plan: subPlan, span: expr.span };
		}
		case "exists": {
			// `exists (subquery)` — le subquery est TOUJOURS un Expr.subquery
			// (invariant parser). On unwrap pour obtenir le LogicalPlan direct.
			if (expr.subquery.type !== "subquery") {
				throw new SnqlError(
					"'exists' attend une sub-query (bug parser)",
					"lower_exists_not_subquery",
					expr.span
				);
			}
			const subPlan = lower(expr.subquery.query, moduleSchema);
			return { kind: "exists", subplan: subPlan, span: expr.span };
		}
		case "cast": {
			// Défense-en-profondeur : le parser filtre déjà via CAST_TARGETS, mais un
			// PlanExpr construit à la main (tests, futur workflow) pourrait passer un
			// target invalide.
			if (!CAST_TARGETS.has(expr.target)) {
				throw new SnqlError(
					`Type de cast '${expr.target}' hors canoniques (int, float, text, bool, date, timestamp, json)`,
					"lower_cast_unknown_target",
					expr.targetSpan
				);
			}
			const operand = lowerExpr(expr.operand);
			// cast(<string literal> as json) : parse au lower
			// et remplacement statique par object/array/scalar literal. Cross-
			// engine (aucun engine-specific code). Fires SnqlError si JSON.parse
			// échoue — signale l'erreur au parse-time, pas au runtime silent.
			if (
				expr.target === "json" &&
				operand.kind === "literal" &&
				typeof operand.value === "string"
			) {
				return parseJsonLiteralToPlanExpr(
					operand.value,
					operand.span ?? expr.span
				);
			}
			// Span de l'operand pour cibler PG 22P02 (`invalid input syntax for … : "X"`)
			// sur le fragment fautif — pas sur le mot-clé `cast`.
			return {
				kind: "cast",
				target: expr.target as CastTarget,
				operand,
				span: operand.span ?? expr.span
			};
		}
		case "object":
			return {
				kind: "object",
				entries: expr.entries.map((e) => ({
					key: e.key,
					value: lowerExpr(e.value)
				})),
				span: expr.span
			};
		case "array":
			return {
				kind: "array",
				items: expr.items.map(lowerExpr),
				span: expr.span
			};
		case "case": {
			// Garde `lower_case_cond_type` : refuse un `cond` dont on peut prouver
			// statiquement qu'il n'est pas bool. On accepte tout ce qu'on ne peut
			// pas prouver faux (field, call, arith, compare, logical, not, in,
			// cast) — la validation runtime PG/Mongo prend le relais si nécessaire.
			for (const branch of expr.branches) {
				assertCondIsBoolShaped(branch.cond, "case");
			}
			// Garde `lower_case_branches_type_mismatch` : si toutes les valeurs
			// (branches + elseValue) sont des littéraux de kinds différents,
			// signaler tôt — PG throwera sinon avec un `CASE types cannot be
			// matched` opaque. Composites (object/array) → kind=`json`.
			assertBranchLiteralsHomogeneous(
				expr.branches.map((b) => b.value).concat(expr.elseValue),
				"case"
			);
			return {
				kind: "case",
				branches: expr.branches.map((b) => ({
					cond: lowerExpr(b.cond),
					value: lowerExpr(b.value)
				})),
				elseValue: lowerExpr(expr.elseValue),
				span: expr.span
			};
		}
	}
}

/**
 * bool-shape check pour `case` / `if` cond. On refuse les
 * littéraux non-bool prouvés (number / string / null / object / array). Un
 * `cond` field/call/arith/etc. passe — trop coûteux à typer statiquement, PG
 * throwera 22P02 si non-bool réel.
 */
function assertCondIsBoolShaped(cond: Expr, ctx: "case" | "if"): void {
	const kind = literalKindOrNull(cond);
	if (kind === null || kind === "boolean") return;
	const errCode =
		ctx === "case" ? "lower_case_cond_type" : "lower_if_cond_type";
	const prefix = ctx === "case" ? "case { cond -> … }" : "if(cond, …, …)";
	throw new SnqlError(
		`${prefix} : cond doit être booléen — reçu littéral ${kind}`,
		errCode,
		cond.span
	);
}

/**
 * garde d'homogénéité des branches. Si TOUTES les valeurs
 * fournies sont des littéraux et que leurs kinds diffèrent, on refuse au lower
 * plutôt que de laisser PG throw un `CASE types cannot be matched` opaque
 * (Mongo tolère plus, mais la promesse SNQL cross-engine impose PG comme
 * plancher). Object/array literals → kind `json` unifié.
 */
function assertBranchLiteralsHomogeneous(
	values: readonly Expr[],
	ctx: "case" | "if"
): void {
	const kinds: string[] = [];
	for (const v of values) {
		const k = literalKindOrNull(v);
		if (k === null) return; // Non-littéral → skip la garde
		if (k === "null") continue; // NULL polymorphe → homogène avec tout
		kinds.push(k);
	}
	const unique = new Set(kinds);
	if (unique.size <= 1) return;
	const errCode =
		ctx === "case"
			? "lower_case_branches_type_mismatch"
			: "lower_if_branches_type_mismatch";
	const prefix = ctx === "case" ? "case { … }" : "if(…)";
	throw new SnqlError(
		`${prefix} : branches de types incompatibles {${[...unique].join(", ")}} — cast explicite requis (ex: cast(x as text))`,
		errCode,
		values[0]!.span
	);
}

/**
 * Retourne le kind statique d'un `Expr` si littéral (`number`, `string`,
 * `boolean`, `null`, `json` pour object/array), sinon `null`. Sert aux gardes
 * `lower_*_cond_type` et `lower_*_branches_type_mismatch`.
 */
function literalKindOrNull(expr: Expr): string | null {
	if (expr.type === "literal") return expr.value.kind;
	if (expr.type === "object" || expr.type === "array") return "json";
	return null;
}

/**
 * Hints par nom de fonction reserved — pointe l'alternative.
 * Utilisé par `lower_call_reserved` pour un message actionnable.
 */
const RESERVED_FUNCTION_HINTS: Readonly<Record<string, string>> = {
	regex_replace: "(registre string étendu)",
	json_contains:
		"(attend object-literal SNQL natif — utilise json_get + composition d'ici là)",
	json_set: "(coordination avec `set doc.a.b = value` natif SNQL)",
	json_delete: "(idem json_set)",
	json_merge: "(design deep-merge vs shallow)",
	json_path:
		"(JSONPath complet — utilise json_get variadic pour l'accès simple)",
	json_array_length:
		"(cluster introspection étendue — utilise length ou compose)",
	json_length:
		"(cardinalité unifiée array/object — utilise length pour arrays)",
	json_object_keys:
		"(set-returning, nécessite décision array-typed returns)"
};

/**
 * Aliases connus vers les canoniques SNQL — suggestions pour
 * `lower_unknown_function`. Chaque `?` d'un dev perdu = un alias à ajouter.
 */
const FUNCTION_ALIASES: Readonly<Record<string, string>> = {
	regexp_replace: "regex_replace (réservé)",
	position: "strpos",
	instr: "strpos",
	substr: "substring",
	ceiling: "ceil",
	datediff: "date_diff",
	dateadd: "date_add",
	current_date: "today()",
	current_timestamp: "now()",
	sysdate: "now()",
	getdate: "now()"
};

/** Distance d'édition (Damerau-Levenshtein 1-swap) — utilisé pour les
 * suggestions "voulez-vous dire" sur les units. Coût O(n*m), négligeable pour
 * des chaînes de ≤ 20 chars. */
function editDistance(a: string, b: string): number {
	if (a === b) return 0;
	const la = a.length;
	const lb = b.length;
	if (la === 0) return lb;
	if (lb === 0) return la;
	let prev: number[] = Array(lb + 1);
	for (let j = 0; j <= lb; j += 1) prev[j] = j;
	let curr: number[] = Array(lb + 1);
	for (let i = 1; i <= la; i += 1) {
		curr[0] = i;
		for (let j = 1; j <= lb; j += 1) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			curr[j] = Math.min(
				(curr[j - 1] as number) + 1,
				(prev[j] as number) + 1,
				(prev[j - 1] as number) + cost
			);
		}
		[prev, curr] = [curr, prev];
	}
	return prev[lb] as number;
}

/** Trouve la meilleure suggestion dans une whitelist (distance ≤ 2, plus courte gagne). */
function bestSuggestion(
	input: string,
	candidates: readonly string[]
): string | null {
	let best: { name: string; dist: number } | null = null;
	for (const cand of candidates) {
		const d = editDistance(input.toLowerCase(), cand);
		if (d <= 2 && (best === null || d < best.dist)) {
			best = { name: cand, dist: d };
		}
	}
	return best?.name ?? null;
}

/**
 * Résout un appel de fonction contre le registre : fonction connue, arité
 * conforme, kind non-`reserved`. Types opt-in : si `entry.args` est déclaré et
 * que l'arg correspondant est statiquement typable (littéral), on vérifie.
 * `argEnum` : whitelist pour un arg littéral string (unit de date_*)
 * avec suggestion Levenshtein sur valeur hors whitelist.
 */
function lowerCall(expr: Expr & { type: "call" }): PlanExpr {
	const entry = SNQL_FUNCTIONS.get(expr.name);
	if (entry === undefined) {
		const aliasHint = FUNCTION_ALIASES[expr.name];
		const message =
			aliasHint !== undefined
				? `Fonction '${expr.name}' inconnue — utilisez '${aliasHint}'`
				: `Fonction '${expr.name}' inconnue`;
		throw new SnqlError(message, "lower_unknown_function", expr.span);
	}
	if (entry.kind === "reserved") {
		const hint = RESERVED_FUNCTION_HINTS[expr.name];
		const message =
			hint !== undefined
				? `Fonction '${expr.name}' réservée — ${hint}`
				: `Fonction '${expr.name}' réservée — pas encore implémentée`;
		throw new SnqlError(message, "lower_call_reserved", expr.span);
	}
	// guards call-level pour star / unique / aggregates.
	// Defense-in-depth : le parser fast-path garantit déjà les invariants
	// structurels ; ces checks capturent un PlanExpr construit programmatiquement
	// (tests, futur workflow) qui bypasserait le parser.
	if (expr.star === true && expr.name !== "count") {
		throw new SnqlError(
			`'${expr.name}(*)' — '*' est réservé à count(*)`,
			"lower_call_star_only_count",
			expr.span
		);
	}
	if (expr.unique === true) {
		if (entry.kind !== "aggregate" && entry.kind !== "aggregateMulti") {
			throw new SnqlError(
				`'${expr.name}(unique ...)' — le modifier 'unique' est réservé aux aggregates (count/sum/avg/min/max, array_agg/string_agg/json_agg)`,
				"lower_call_unique_aggregate_only",
				expr.span
			);
		}
		// aggregate mono-arg (count/sum/avg/min/max) exige 1 arg avec unique.
		// aggregateMulti (array_agg, json_agg) : 1 arg. string_agg : 2 args.
		// On check via arity min (déjà validée à la ligne suivante).
		if (entry.kind === "aggregate" && expr.args.length !== 1) {
			throw new SnqlError(
				`'${expr.name}(unique ...)' attend exactement 1 argument, reçu ${expr.args.length} (arité mono-arg cross-engine)`,
				"lower_call_unique_arity",
				expr.span
			);
		}
		if (expr.name === "min" || expr.name === "max") {
			throw new SnqlError(
				`'${expr.name}(unique ...)' refusé — 'unique' n'a pas d'effet sur ${expr.name} (retire 'unique')`,
				"lower_call_unique_no_op_min_max",
				expr.span
			);
		}
	}
	// sortKeys — parser filtre déjà (contextual via registry),
	// defense-in-depth : refuse si présent sur non-aggregateMulti (bug parser).
	if (expr.sortKeys !== undefined && expr.sortKeys.length > 0) {
		if (entry.kind !== "aggregateMulti") {
			throw new SnqlError(
				`'${expr.name}(... sort ...)' — 'sort' intra-call réservé aux aggregateMulti (array_agg / string_agg / json_agg)`,
				"lower_call_sort_aggregate_multi_only",
				expr.span
			);
		}
	}
	// count() nu (sans star, 0 args) — piège UX : arity accepte 0-1 pour count
	// afin de laisser passer count(*), mais count() seul n'a pas de sémantique.
	if (expr.name === "count" && expr.star !== true && expr.args.length === 0) {
		throw new SnqlError(
			"count() sans argument — utilise 'count(*)' pour compter les rows ou 'count(<expr>)' pour compter les non-null",
			"lower_call_count_missing_arg",
			expr.span
		);
	}
	const arityMsg = checkArity(expr.name, entry.arity, expr.args.length);
	if (arityMsg !== null) {
		throw new SnqlError(arityMsg, "lower_call_arity", expr.span);
	}
	// Type check opt-in — on ne vérifie que ce qu'on peut statiquement (littéraux).
	if (entry.args !== undefined) {
		for (let i = 0; i < expr.args.length && i < entry.args.length; i += 1) {
			const declared = entry.args[i];
			if (declared === undefined || declared === "any") continue;
			const arg = expr.args[i];
			if (arg?.type === "literal") {
				const litKind = arg.value.kind;
				const mismatch =
					(declared === "string" && litKind !== "string") ||
					(declared === "number" && litKind !== "number") ||
					(declared === "bool" && litKind !== "boolean");
				if (mismatch) {
					throw new SnqlError(
						`Fonction '${expr.name}' arg ${i + 1} attend ${declared}, reçu ${litKind}`,
						"lower_call_type",
						arg.span
					);
				}
			}
		}
	}
	// argEnum : whitelist stricte pour les unit littéraux (date_*).
	if (entry.argEnum !== undefined) {
		for (let i = 0; i < expr.args.length && i < entry.argEnum.length; i += 1) {
			const whitelist = entry.argEnum[i];
			if (whitelist === undefined) continue;
			const arg = expr.args[i];
			if (arg === undefined) continue;
			if (arg.type !== "literal" || arg.value.kind !== "string") {
				throw new SnqlError(
					`Fonction '${expr.name}' arg ${i + 1} attend un littéral string parmi {${whitelist.join(", ")}}, pas une expression dynamique`,
					"lower_call_enum_literal_required",
					arg.span
				);
			}
			const value = arg.value.value.toLowerCase();
			if (!whitelist.includes(value)) {
				const suggestion = bestSuggestion(value, whitelist);
				const suggestionHint =
					suggestion !== null ? ` — voulez-vous dire '${suggestion}' ?` : "";
				throw new SnqlError(
					`Fonction '${expr.name}' arg ${i + 1} '${arg.value.value}' hors enum {${whitelist.join(", ")}}${suggestionHint}`,
					"lower_call_enum_value",
					arg.span
				);
			}
		}
	}
	// Guards dédiés : catch les pièges courants avec un message actionnable.
	if (entry.name === "substring") {
		const startArg = expr.args[1];
		if (
			startArg?.type === "literal" &&
			startArg.value.kind === "number" &&
			Number(startArg.value.raw) === 0
		) {
			throw new SnqlError(
				"substring est 1-indexed — voulez-vous dire substring(s, 1, ...) ?",
				"lower_call_substring_zero_index",
				startArg.span
			);
		}
	}
	if (entry.name === "replace") {
		const fromArg = expr.args[1];
		if (
			fromArg?.type === "literal" &&
			fromArg.value.kind === "string" &&
			fromArg.value.value === ""
		) {
			throw new SnqlError(
				"replace : `from` vide non supporté cross-engine (PG no-op, Mongo null/throw)",
				"lower_call_replace_empty_find",
				fromArg.span
			);
		}
	}
	if (entry.name === "json_get" || entry.name === "json_get_text") {
		validateJsonPathSegments(expr, entry.name);
	}
	if (entry.name === "json_has_key") {
		validateJsonHasKey(expr);
	}
	// guards spécifiques `if(cond, then, else)` — miroir des
	// gardes `case`. cond bool-shaped + branches homogènes (then/else).
	if (entry.name === "if" && expr.args.length === 3) {
		assertCondIsBoolShaped(expr.args[0]!, "if");
		assertBranchLiteralsHomogeneous([expr.args[1]!, expr.args[2]!], "if");
	}
	// forward star/unique flags sur PlanCall — le codegen les
	// consomme via ctx.star / ctx.unique.
	// forward sortKeys (aggregateMulti) — le codegen les
	// consomme via ctx.sortKeys + accès direct au PlanCall.sortKeys.
	const loweredSortKeys =
		expr.sortKeys !== undefined && expr.sortKeys.length > 0
			? expr.sortKeys.map((k) => ({ path: k.path, direction: k.direction }))
			: undefined;
	return {
		kind: "call",
		name: expr.name,
		args: expr.args.map(lowerExpr),
		...(expr.star === true ? { star: true as const } : {}),
		...(expr.unique === true ? { unique: true as const } : {}),
		...(loweredSortKeys !== undefined ? { sortKeys: loweredSortKeys } : {}),
		span: expr.span
	};
}

/**
 * lower d'un windowCall. Vérifie l'existence dans le registre
 * + kind=window + arité + refus contextes non-pick (validé en amont par le
 * walker). Retourne un PlanExpr.windowCall.
 */
function lowerWindowCall(expr: Expr & { type: "windowCall" }): PlanExpr {
	const entry = SNQL_FUNCTIONS.get(expr.name);
	if (entry === undefined) {
		throw new SnqlError(
			`Fonction '${expr.name}' inconnue`,
			"lower_unknown_function",
			expr.span
		);
	}
	if (entry.kind !== "window") {
		// Defense-in-depth : parser filtre déjà (parse_over_not_window).
		throw new SnqlError(
			`'${expr.name}' n'est pas une window function`,
			"lower_windowcall_not_window",
			expr.span
		);
	}
	const arityMsg = checkArity(expr.name, entry.arity, expr.args.length);
	if (arityMsg !== null) {
		throw new SnqlError(arityMsg, "lower_call_arity", expr.span);
	}
	return {
		kind: "windowCall",
		name: expr.name,
		args: expr.args.map(lowerExpr),
		partitionKeys: expr.partitionKeys,
		sortKeys: expr.sortKeys.map((k) => ({
			path: k.path,
			direction: k.direction
		})),
		span: expr.span
	};
}

/**
 * walker AST — refuse windowCall dans une position autre que
 * pick.expr. Utilisé par where/having/group by/sort/set predicates.
 */
function refuseWindowCallInPosition(
	expr: Expr,
	code: string,
	positionLabel: string
): void {
	const span = firstWindowCallSpanAst(expr);
	if (span === undefined) return;
	throw new SnqlError(
		`Window function dans '${positionLabel}' non autorisée — les window fns produisent une valeur per-row ordonnée qui n'a de sens qu'en projection; utilise un pick + sub-query pour filtrer`,
		code,
		span
	);
}

/**
 * walker AST — true ssi l'expression contient un windowCall
 * (au top ou nested dans un scalar wrapper). Utilisé pour détecter le mix
 * window+agg dans un pick.
 */
function containsWindowCallAst(expr: Expr): boolean {
	return firstWindowCallSpanAst(expr) !== undefined;
}

function firstWindowCallSpanAst(
	expr: Expr
): import("../lexer/token").Span | undefined {
	if (expr.type === "windowCall") return expr.span;
	if (expr.type === "call") {
		for (const arg of expr.args) {
			const s = firstWindowCallSpanAst(arg);
			if (s !== undefined) return s;
		}
		return undefined;
	}
	switch (expr.type) {
		case "literal":
		case "field":
			return undefined;
		case "compare":
		case "logical":
		case "arith":
			return (
				firstWindowCallSpanAst(expr.left) ?? firstWindowCallSpanAst(expr.right)
			);
		case "not":
			return firstWindowCallSpanAst(expr.operand);
		case "in": {
			const t = firstWindowCallSpanAst(expr.target);
			if (t !== undefined) return t;
			for (const v of expr.values) {
				const s = firstWindowCallSpanAst(v);
				if (s !== undefined) return s;
			}
			return undefined;
		}
		case "cast":
			return firstWindowCallSpanAst(expr.operand);
		case "object":
			for (const e of expr.entries) {
				const s = firstWindowCallSpanAst(e.value);
				if (s !== undefined) return s;
			}
			return undefined;
		case "array":
			for (const i of expr.items) {
				const s = firstWindowCallSpanAst(i);
				if (s !== undefined) return s;
			}
			return undefined;
		case "case": {
			for (const b of expr.branches) {
				const s =
					firstWindowCallSpanAst(b.cond) ?? firstWindowCallSpanAst(b.value);
				if (s !== undefined) return s;
			}
			return firstWindowCallSpanAst(expr.elseValue);
		}
		case "subquery":
		case "exists":
			// uncorrelated — pas de window ref outer.
			return undefined;
	}
}

/**
 * Valide les segments path d'un `json_get`/`json_get_text` variadic. Chaque
 * segment (args[1..]) doit être un littéral string non-vide OU un littéral
 * number entier positif ≤ INT32_MAX. Rejet précoce au lower — le renderer
 * discrimine sur le type de la value pour choisir `::text` / `::int`.
 */
function validateJsonPathSegments(
	expr: Expr & { type: "call" },
	fnName: string
): void {
	// args[0] = doc, args[1..] = segments path
	if (expr.args.length < 2) {
		throw new SnqlError(
			`Fonction '${fnName}' attend au moins un segment path (ex: ${fnName}(doc, "key") ou ${fnName}(doc, "a", 0, "b"))`,
			"lower_call_json_path_empty",
			expr.span
		);
	}
	for (let i = 1; i < expr.args.length; i += 1) {
		const seg = expr.args[i]!;
		if (seg.type !== "literal") {
			throw new SnqlError(
				`Fonction '${fnName}' segment path ${i} : expression dynamique non supportée v1 — attend un littéral string ou int`,
				"lower_call_json_path_dynamic_segment",
				seg.span
			);
		}
		const v = seg.value;
		if (v.kind === "string") {
			if (v.value === "") {
				throw new SnqlError(
					`Fonction '${fnName}' segment path ${i} : string vide refusée`,
					"lower_call_json_path_empty_segment",
					seg.span
				);
			}
			continue;
		}
		if (v.kind === "number") {
			// Raw parsing : rejeter float, bigint hors range, décimal exact.
			if (/[.eE]/.test(v.raw)) {
				throw new SnqlError(
					`Fonction '${fnName}' segment path ${i} : type reçu float — attend int littéral positif`,
					"lower_call_json_path_invalid_segment_type",
					seg.span
				);
			}
			const n = Number(v.raw);
			if (!Number.isInteger(n)) {
				throw new SnqlError(
					`Fonction '${fnName}' segment path ${i} : type reçu non-int — attend int littéral positif`,
					"lower_call_json_path_invalid_segment_type",
					seg.span
				);
			}
			if (n < 0) {
				throw new SnqlError(
					`Fonction '${fnName}' segment path ${i} : index négatif refusé v1 (support natif PG/Mongo différé)`,
					"lower_call_json_path_negative_index",
					seg.span
				);
			}
			if (n > 2147483647) {
				throw new SnqlError(
					`Fonction '${fnName}' segment path ${i} : index > INT32_MAX (PG '->' overload jsonb∘int n'a pas de variante bigint)`,
					"lower_call_json_path_int_overflow",
					seg.span
				);
			}
			continue;
		}
		throw new SnqlError(
			`Fonction '${fnName}' segment path ${i} : type reçu ${v.kind} — attend un littéral string ou int`,
			"lower_call_json_path_invalid_segment_type",
			seg.span
		);
	}
}

/** Valide `json_has_key(doc, key)` : key doit être un literal string non-vide. */
function validateJsonHasKey(expr: Expr & { type: "call" }): void {
	const keyArg = expr.args[1];
	if (keyArg === undefined) return; // arity l'attrapera avant
	if (keyArg.type !== "literal" || keyArg.value.kind !== "string") {
		throw new SnqlError(
			"json_has_key : arg 2 (key) attend un littéral string, pas une expression dynamique",
			"lower_call_json_has_key_dynamic_key",
			keyArg.span
		);
	}
	if (keyArg.value.value === "") {
		throw new SnqlError(
			"json_has_key : arg 2 (key) string vide refusée",
			"lower_call_json_has_key_empty_key",
			keyArg.span
		);
	}
}

/**
 * Refuse un call bool-returning en position bare de prédicat where
 * (`where json_has_key(doc, 'k')` sans `= true/false`). Aligne le comportement
 * cross-engine : PG accepterait bool nu mais Mongo throw à la traduction —
 * l'asymétrie surprend le dev. Rejet au lower avec message actionnable.
 *
 * Bool-returning aujourd'hui = `json_has_key`. Extensible via un
 * champ registry futur ; hardcoded ici pour éviter la modif du shape.
 */
const BOOL_RETURNING_CALLS: ReadonlySet<string> = new Set(["json_has_key"]);

function assertNoBareCallPredicate(expr: Expr): void {
	// Case en position bare where (`where case { … }`) refusé — non-booléen
	// par nature. Le dev doit comparer explicitement (`case { … } = true`).
	if (expr.type === "case") {
		throw new SnqlError(
			"'case { … }' n'est pas un prédicat — compare le résultat avec une valeur (ex: case { … } = true)",
			"lower_case_bare_predicate",
			expr.span
		);
	}
	if (expr.type !== "call") return;
	if (!BOOL_RETURNING_CALLS.has(expr.name)) return;
	throw new SnqlError(
		`Fonction bool '${expr.name}' en position bare de where — écris '${expr.name}(...) = true' ou '= false' (aligne le comportement cross-engine)`,
		"lower_call_bool_bare_predicate",
		expr.span
	);
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
 *
 * Le `span` est celui du node `compare` AST source — il englobe l'expression
 * complète canonicalisée (utile pour souligner `x = null` en une seule marque).
 */
function lowerCompare(
	operator: CompareOperator,
	left: PlanExpr,
	right: PlanExpr,
	span: import("../lexer/token").Span
): PlanExpr {
	const op = COMPARE_MAP[operator];
	if (op === "eq" || op === "ne") {
		const leftNull = isNullLiteral(left);
		const rightNull = isNullLiteral(right);
		if (leftNull || rightNull) {
			const operand = leftNull ? right : left;
			return { kind: "isNull", negated: op === "ne", operand, span };
		}
	}
	// `like` n'est pas commutatif : jamais d'échange.
	if (op !== "like" && left.kind !== "field" && right.kind === "field") {
		return { kind: "compare", op: FLIP_OP[op], left: right, right: left, span };
	}
	return { kind: "compare", op, left, right, span };
}

function isNullLiteral(expr: PlanExpr): boolean {
	return expr.kind === "literal" && expr.value === null;
}

/**
 * parse un JSON string literal en PlanExpr statique. Utilisé
 * pour rewriter `cast('{"k":1}' as json)` en `{k: 1}` object literal au lower,
 * cross-engine. Convertit récursivement chaque valeur JSON en son PlanExpr
 * équivalent (object/array/literal). Fires SnqlError si JSON.parse échoue.
 */
function parseJsonLiteralToPlanExpr(
	raw: string,
	span: import("../lexer/token").Span | undefined
): PlanExpr {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		throw new SnqlError(
			`cast('...' as json) — le string literal n'est pas du JSON valide : ${message}`,
			"lower_cast_json_string_invalid",
			span
		);
	}
	return jsValueToPlanExpr(parsed, span);
}

function jsValueToPlanExpr(
	value: unknown,
	span: import("../lexer/token").Span | undefined
): PlanExpr {
	const spanOpt = span !== undefined ? { span } : {};
	if (value === null) return { kind: "literal", value: null, ...spanOpt };
	if (typeof value === "string") return { kind: "literal", value, ...spanOpt };
	if (typeof value === "boolean") return { kind: "literal", value, ...spanOpt };
	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			throw new SnqlError(
				"cast('...' as json) — JSON contient une valeur numérique hors IEEE-754 finie",
				"lower_cast_json_string_invalid",
				span
			);
		}
		return { kind: "literal", value, ...spanOpt };
	}
	if (Array.isArray(value)) {
		return {
			kind: "array",
			items: value.map((item) => jsValueToPlanExpr(item, span)),
			...spanOpt
		};
	}
	if (typeof value === "object") {
		return {
			kind: "object",
			entries: Object.entries(value as Record<string, unknown>).map(
				([key, val]) => ({ key, value: jsValueToPlanExpr(val, span) })
			),
			...spanOpt
		};
	}
	throw new SnqlError(
		`cast('...' as json) — type JSON parsé non supporté (${typeof value})`,
		"lower_cast_json_string_invalid",
		span
	);
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

/**
 * Préserve la précision : décimal → `SqlDecimal` (texte brut exact) ; entier hors
 * plage sûre → bigint ; sinon number. On ne passe JAMAIS un décimal par `Number()`.
 */
function numberRawToValue(raw: string): SqlValue {
	if (FLOAT_HINT.test(raw)) {
		return { kind: "decimal", raw };
	}
	const asNumber = Number(raw);
	return Number.isSafeInteger(asNumber) ? asNumber : BigInt(raw);
}

// ═══════════════════════════════════════════════════════════════════════════
// typecheck cross-type au lower (schema-aware)
//
// Positions typecheckées : compare (=, !=, <, <=, >, >=), in [values]/subquery,
// arith (+/-/*//%), like. Permissif si schema absent ou type inconnu (aucun
// faux positif).
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Groupe de compatibilité — types dans le même groupe sont interchangeables
 * en comparaison (widening implicite). Aligné sur les casts SQL naturels
 * cross-engine.
 *
 *  - numeric : int / bigint / float / decimal — widening OK
 *  - string : string / uuid — string-encoded, comparable
 *  - bool : bool strict
 *  - date : date (englobe timestamp/date-only cross-engine)
 *  - json : opaque, matchable avec tout (impossible à typer statiquement)
 *  - array : opaque
 *  - unknown : wildcard (schema absent, field non-résolu, call sans type)
 */
type TypeGroup =
	| "numeric"
	| "string"
	| "bool"
	| "date"
	| "json"
	| "array"
	| "unknown";

function snqlTypeGroup(t: SnqlType): TypeGroup {
	if (t === "int" || t === "bigint" || t === "float" || t === "decimal") {
		return "numeric";
	}
	// `enum` groupé avec `string` — l'enum PG accepte les
	// littéraux string compatibles (`role = "field_expert"`). Un typecheck plus
	// strict (whitelist des labels) sera fait par un walker dédié plus tard.
	if (t === "string" || t === "uuid" || t === "enum") return "string";
	if (t === "bool") return "bool";
	if (t === "date") return "date";
	if (t === "json") return "json";
	if (t === "array") return "array";
	return "unknown";
}

/**
 * True ssi les 2 types sont compatibles pour une comparaison ou un in.
 * Permissif sur `unknown` et `json` (wildcards).
 */
function typesCompatible(a: SnqlType, b: SnqlType): boolean {
	const ga = snqlTypeGroup(a);
	const gb = snqlTypeGroup(b);
	if (ga === "unknown" || gb === "unknown") return true;
	if (ga === "json" || gb === "json") return true;
	return ga === gb;
}

/**
 * True ssi le type est numérique (utilisé par arith).
 */
function isNumericType(t: SnqlType): boolean {
	const g = snqlTypeGroup(t);
	return g === "numeric" || g === "unknown" || g === "json";
}

/**
 * True ssi le type est string (utilisé par like).
 */
function isStringType(t: SnqlType): boolean {
	const g = snqlTypeGroup(t);
	return g === "string" || g === "unknown" || g === "json";
}

/**
 * Mapping CastTarget → SnqlType (aligné avec CAST_TO_SNQL_TYPE de
 * infer-column-types.ts). `int` → bigint (large, cover safe integers).
 * `timestamp` collapse en `date` (SnqlType n'a pas de timestamp distinct).
 */
function castTargetToSnqlType(target: CastTarget): SnqlType {
	switch (target) {
		case "int":
			return "bigint";
		case "float":
			return "float";
		case "text":
			return "string";
		case "bool":
			return "bool";
		case "date":
		case "timestamp":
			return "date";
		case "json":
			return "json";
	}
}

/**
 * Résout le type d'une expression AST — best-effort. Retourne `unknown` en
 * fallback (permissif). Ne gère PAS les calls (return type non exposé dans
 * le registre v1).
 */
function resolveExprType(
	expr: Expr,
	source: { readonly collection: string; readonly alias?: string },
	schema: SchemaModel | undefined
): SnqlType {
	if (expr.type === "literal") {
		switch (expr.value.kind) {
			case "number":
				return "float"; // widest numeric — accepte int/bigint/decimal via widening
			case "string":
				return "string";
			case "boolean":
				return "bool";
			case "null":
				return "unknown"; // null matche tout
		}
	}
	if (expr.type === "field") {
		if (schema === undefined) return "unknown";
		return resolveFieldTypeInAst(expr.path, source, schema);
	}
	if (expr.type === "cast") {
		return castTargetToSnqlType(expr.target);
	}
	if (expr.type === "arith") {
		return "float"; // arith produit toujours du numérique
	}
	if (expr.type === "subquery") {
		// Type de la 1re field du pick de la subquery.
		const pickStage = expr.query.stages.find((s) => s.type === "pick");
		if (pickStage?.type !== "pick" || pickStage.fields.length === 0) {
			return "unknown";
		}
		const first = pickStage.fields[0]!;
		const subSource = {
			collection: expr.query.source.collection,
			...(expr.query.source.alias !== undefined
				? { alias: expr.query.source.alias }
				: {})
		};
		if (first.expr !== undefined) {
			return resolveExprType(first.expr, subSource, schema);
		}
		if (schema !== undefined && first.path.length > 0) {
			return resolveFieldTypeInAst(first.path, subSource, schema);
		}
		return "unknown";
	}
	if (expr.type === "object") return "json";
	if (expr.type === "array") return "array";
	// call, case, in, compare, logical, not, windowCall, exists → unknown v1
	return "unknown";
}

/**
 * Résout le type d'un field path en tenant compte de l'alias source.
 * `path.length !== 1` post-alias-strip → unknown (nested JSON, aliased join).
 */
function resolveFieldTypeInAst(
	path: readonly string[],
	source: { readonly collection: string; readonly alias?: string },
	schema: SchemaModel
): SnqlType {
	// path `outerAlias.field` — chercher dans les scopes outer.
	// Ex : `find users as u where exists (find orders as o where o.total > u.age)`
	// → `u.age` doit résoudre vers `users.age` via outer scope.
	if (path.length === 2) {
		const head = path[0]!;
		const rest = path[1]!;
		// Priorité 1 : alias source current
		if (source.alias === head) {
			const coll = schema.collections.find((c) => c.name === source.collection);
			return coll?.fields.find((f) => f.name === rest)?.type ?? "unknown";
		}
		// Priorité 2 : outer scopes (correlated)
		for (let i = outerScopeStack.length - 1; i >= 0; i -= 1) {
			const outerScope = outerScopeStack[i]!;
			const matchesAlias = outerScope.alias === head;
			if (matchesAlias) {
				const coll = schema.collections.find(
					(c) => c.name === outerScope.collection
				);
				return coll?.fields.find((f) => f.name === rest)?.type ?? "unknown";
			}
		}
	}
	const stripped =
		source.alias !== undefined && path.length > 1 && path[0] === source.alias
			? path.slice(1)
			: path;
	if (stripped.length !== 1) return "unknown"; // nested Mongo or joined alias
	const coll = schema.collections.find((c) => c.name === source.collection);
	const field = coll?.fields.find((f) => f.name === stripped[0]);
	return field?.type ?? "unknown";
}

/**
 * Walker AST — typecheck récursif de tous les compare/in/arith/like d'une
 * expression. Uncorrelated pour les sub-queries (chaque subquery est
 * typecheckée dans son propre source context). No-op si schema absent.
 */
function typecheckExprTypes(
	expr: Expr,
	source: { readonly collection: string; readonly alias?: string },
	schema: SchemaModel | undefined
): void {
	if (schema === undefined) return;
	switch (expr.type) {
		case "literal":
		case "field":
			return;
		case "compare": {
			typecheckExprTypes(expr.left, source, schema);
			typecheckExprTypes(expr.right, source, schema);
			if (expr.operator === "like") {
				// like : target doit être string.
				const targetT = resolveExprType(expr.left, source, schema);
				if (!isStringType(targetT)) {
					throw new SnqlError(
						`'like' attend une string à gauche, reçu ${targetT} — cast explicite requis (ex: cast(x as text))`,
						"lower_type_mismatch_like",
						expr.span
					);
				}
				const patternT = resolveExprType(expr.right, source, schema);
				if (!isStringType(patternT)) {
					throw new SnqlError(
						`'like' attend un motif string à droite, reçu ${patternT}`,
						"lower_type_mismatch_like",
						expr.span
					);
				}
				return;
			}
			const leftT = resolveExprType(expr.left, source, schema);
			const rightT = resolveExprType(expr.right, source, schema);
			if (!typesCompatible(leftT, rightT)) {
				throw new SnqlError(
					`Comparaison '${expr.operator}' entre types incompatibles : ${leftT} vs ${rightT} — cast explicite requis (ex: cast(x as ${leftT}))`,
					"lower_type_mismatch_compare",
					expr.span
				);
			}
			return;
		}
		case "logical":
			typecheckExprTypes(expr.left, source, schema);
			typecheckExprTypes(expr.right, source, schema);
			return;
		case "not":
			typecheckExprTypes(expr.operand, source, schema);
			return;
		case "in": {
			typecheckExprTypes(expr.target, source, schema);
			// in (subquery) — target vs 1re field du pick sub.
			if (expr.values.length === 1 && expr.values[0]?.type === "subquery") {
				const subExpr = expr.values[0]!;
				// Descend dans la subquery pour typecheck son propre contenu
				// (uncorrelated — son propre source context).
				typecheckQuery((subExpr as Expr & { type: "subquery" }).query, schema);
				const targetT = resolveExprType(expr.target, source, schema);
				const subT = resolveExprType(subExpr, source, schema);
				if (!typesCompatible(targetT, subT)) {
					throw new SnqlError(
						`'in (subquery)' entre types incompatibles : ${targetT} vs ${subT} — la subquery projette du ${subT}, cast explicite requis`,
						"lower_type_mismatch_in_subquery",
						expr.span
					);
				}
				return;
			}
			// in [values] : target vs 1er value non-null (parité SQL).
			const targetT = resolveExprType(expr.target, source, schema);
			for (const v of expr.values) {
				typecheckExprTypes(v, source, schema);
				const vt = resolveExprType(v, source, schema);
				if (!typesCompatible(targetT, vt)) {
					throw new SnqlError(
						`'in [...]' contient une valeur ${vt} incompatible avec le target ${targetT} — homogénéise la liste ou cast explicite`,
						"lower_type_mismatch_in",
						v.span
					);
				}
			}
			return;
		}
		case "arith": {
			typecheckExprTypes(expr.left, source, schema);
			typecheckExprTypes(expr.right, source, schema);
			const leftT = resolveExprType(expr.left, source, schema);
			const rightT = resolveExprType(expr.right, source, schema);
			if (!isNumericType(leftT)) {
				throw new SnqlError(
					`Arithmétique '${expr.operator}' attend un opérande numérique à gauche, reçu ${leftT} — cast explicite requis (ex: cast(x as float))`,
					"lower_type_mismatch_arith",
					expr.span
				);
			}
			if (!isNumericType(rightT)) {
				throw new SnqlError(
					`Arithmétique '${expr.operator}' attend un opérande numérique à droite, reçu ${rightT}`,
					"lower_type_mismatch_arith",
					expr.span
				);
			}
			return;
		}
		case "call":
			for (const arg of expr.args) typecheckExprTypes(arg, source, schema);
			return;
		case "cast":
			typecheckExprTypes(expr.operand, source, schema);
			return;
		case "object":
			for (const entry of expr.entries)
				typecheckExprTypes(entry.value, source, schema);
			return;
		case "array":
			for (const item of expr.items) typecheckExprTypes(item, source, schema);
			return;
		case "case":
			for (const branch of expr.branches) {
				typecheckExprTypes(branch.cond, source, schema);
				typecheckExprTypes(branch.value, source, schema);
			}
			typecheckExprTypes(expr.elseValue, source, schema);
			return;
		case "windowCall":
			for (const arg of expr.args) typecheckExprTypes(arg, source, schema);
			return;
		case "subquery": {
			// push l'outer scope pendant le typecheck récursif
			// pour que resolveFieldTypeInAst puisse résoudre les refs
			// corrélées (`outerAlias.field`).
			const outerScope: OuterScope = {
				aliases: new Set(source.alias !== undefined ? [source.alias] : []),
				sourceColumns: null,
				collection: source.collection,
				...(source.alias !== undefined ? { alias: source.alias } : {})
			};
			outerScopeStack.push(outerScope);
			try {
				typecheckQuery(expr.query, schema);
			} finally {
				outerScopeStack.pop();
			}
			return;
		}
		case "exists":
			typecheckExprTypes(expr.subquery, source, schema);
			return;
	}
}

/**
 * Walker AST au niveau Query — typecheck récursif de tous les stages qui
 * portent des exprs (where, having, pick expressions). Uncorrelated : chaque
 * subquery est typecheckée avec son propre source context.
 */
function typecheckQuery(query: Query, schema: SchemaModel | undefined): void {
	if (schema === undefined) return;
	const source = {
		collection: query.source.collection,
		...(query.source.alias !== undefined ? { alias: query.source.alias } : {})
	};
	for (const stage of query.stages) {
		if (stage.type === "where" || stage.type === "having") {
			typecheckExprTypes(stage.predicate, source, schema);
		} else if (stage.type === "pick") {
			for (const f of stage.fields) {
				if (f.expr !== undefined) typecheckExprTypes(f.expr, source, schema);
			}
		}
	}
}

/**
 * Walker mutation — typecheck du predicate + valeurs de set.
 * propage l'alias source d'un `update t as a` pour que
 * `resolveFieldTypeInAst` puisse résoudre `a.col` proprement. Les cross-alias
 * joins retournent `unknown` (safe fallback — pas de fausse erreur).
 */
function typecheckMutation(
	stmt: InsertStatement | UpdateStatement | DeleteStatement,
	schema: SchemaModel | undefined
): void {
	if (schema === undefined) return;
	if (stmt.operation === "insert") return; // pas d'expressions typables
	const source: { collection: string; alias?: string } =
		stmt.operation === "update" && stmt.alias !== undefined
			? { collection: stmt.collection, alias: stmt.alias }
			: { collection: stmt.collection };
	if (stmt.predicate !== undefined) {
		typecheckExprTypes(stmt.predicate, source, schema);
	}
	if (stmt.operation === "update") {
		for (const a of stmt.assignments) {
			typecheckExprTypes(a.value, source, schema);
		}
	}
}
