import { SnqlError } from "../diagnostics";
import type { Query } from "../parser/ast";
import type { SchemaModel } from "../schema/model";
import { lowerMutation } from "./lower-mutation";
import { lower } from "./lower-query";

/**
 * `let` : liaisons nommées, dont les récursives (`let rec`), abaissées en CTE.
 */

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
