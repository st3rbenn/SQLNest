import { SnqlError } from "../diagnostics";
import type { Expr, Query } from "../parser/ast";
import { RESERVED_SYSTEM_TARGETS } from "../planner/introspect/support";
import type { SchemaModel } from "../schema/model";
import { desugarForwardNav, desugarReverseNav } from "./forward-nav";
import {
	refuseWindowCallInPosition,
	validateHavingAst
} from "./lower-aggregates";
import {
	checkAliasDefined,
	checkColumnsAvailable,
	checkNoEmbedAliasDeref,
	projectionKeys,
	resolveSourceColumns,
	stripAlias
} from "./lower-columns";
import { lowerExpr } from "./lower-expr";
import { MAX_SUBQUERY_DEPTH, outerScopeStack, scopeState } from "./lower-scope";
import { lowerStage } from "./lower-stage";
import { typecheckQuery } from "./lower-typecheck";
import { applyNativeNames } from "./native-names";
import type { LogicalPlan } from "./plan";

/**
 * Requêtes de lecture : de l'AST au plan logique, étape par étape. Récursif
 * par les sous-requêtes — une expression peut contenir une requête, d'où
 * l'import croisé avec `lower-expr`.
 */

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
	// propager aux subqueries. Push l'outer scope (scopeState.current) sur le
	// stack si on est en recursion — la subquery pourra lire ses alias
	// via checkAliasDefined.
	const previousSchema = scopeState.schema;
	const previousCurrentScope = scopeState.current;
	scopeState.schema = schema ?? scopeState.schema;
	if (previousCurrentScope !== null) {
		outerScopeStack.push(previousCurrentScope);
	}
	try {
		const plan = lowerInternal(query, schema ?? scopeState.schema);
		// Les sous-requêtes sont réécrites avec la requête qui les contient,
		// qui seule connaît les alias corrélés.
		return previousCurrentScope === null
			? applyNativeNames(plan, schema ?? scopeState.schema)
			: plan;
	} finally {
		if (previousCurrentScope !== null) outerScopeStack.pop();
		scopeState.current = previousCurrentScope;
		scopeState.schema = previousSchema;
	}
}

function lowerInternal(query: Query, schema?: SchemaModel): LogicalPlan {
	// Refuse un scan sur une table système SQLNest. Hint vers le verbe
	// introspect adapté (aujourd'hui : `list schema_events`). Break net choisi
	// contre alias transparent — un scan de table système via `find` cache la
	// vraie source d'exécution (backend SQLNest) derrière un verbe de query.
	assertNotReservedSystemTarget(query.source.collection, query.source.span);
	// FK/2a forward-nav (ADR-031 D6) : `pick user.name` → injecte le `with users
	// on user_id = id as user` implicite AVANT tout le reste (typecheck + résolution
	// d'alias voient alors le join). No-op sans schéma / sans FK sortante référencée.
	query = desugarForwardNav(query, schema);
	// FK/2b reverse-nav (ADR-031 D7) : `pick orders.count` → join `aggregate:count`
	// corrélé + réécriture du pick vers l'alias scalaire. No-op sans FK entrante.
	query = desugarReverseNav(query, schema);
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
	// initialise scopeState.current = scope de la query courante.
	// Réassigné dynamiquement après chaque `with` join qui ajoute un alias.
	// Consulté par le `lower()` récursif quand une subquery est rencontrée.
	const refreshCurrentScope = (): void => {
		scopeState.current = {
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
			// refresh scopeState.current pour que les subqueries dans
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
 * Refuse un scan sur une table système SQLNest (schema_events et futurs).
 * Message pointe vers le verbe introspect adapté. Break net : coexistence
 * `find schema_events` ↔ `list schema_events` = dette permanente + confusion
 * doc — audit trail = beta interne, casse acceptée.
 */
function assertNotReservedSystemTarget(
	collection: string,
	span: import("../lexer/token").Span
): void {
	if (!RESERVED_SYSTEM_TARGETS.has(collection)) return;
	throw new SnqlError(
		`'${collection}' est une table système SQLNest — utilise 'list ${collection}' (introspection).`,
		"planner_unknown_target_use_introspect",
		span
	);
}
