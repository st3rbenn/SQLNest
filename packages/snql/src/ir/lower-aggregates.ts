import { SnqlError } from "../diagnostics";
import { SNQL_FUNCTIONS } from "../functions";
import type { Expr } from "../parser/ast";
import { stripAlias } from "./lower-columns";
import type { PlanExpr } from "./plan";

/**
 * Agrégats et fonctions de fenêtre : les repérer dans l'AST et refuser les
 * positions où ils n'ont pas de sens.
 */

/**
 * walker AST — true ssi l'expression contient au moins un call
 * dont le kind du registre est `aggregate`. Utilisé pour détecter en amont
 * qu'un pick doit basculer en op='aggregate' (avant lowerField).
 */
export function containsAggregateAst(expr: Expr): boolean {
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
export function validateAggregatePickFieldAst(
	expr: Expr,
	groupKeySet?: ReadonlySet<string>,
	sourceAlias?: string
): void {
	validateInAggWrapperAst(expr, false, groupKeySet, sourceAlias);
}

export function validateHavingAst(
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
					`Aggregate imbriqué '${expr.name}(...)' interdit`,
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
export function refuseAggregateInPosition(
	expr: PlanExpr,
	code: string,
	message: string
): void {
	const span = firstAggregateSpan(expr);
	if (span === undefined) return;
	throw new SnqlError(message, code, span);
}

/**
 * walker AST — refuse windowCall dans une position autre que
 * pick.expr. Utilisé par where/having/group by/sort/set predicates.
 */
export function refuseWindowCallInPosition(
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
export function containsWindowCallAst(expr: Expr): boolean {
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
