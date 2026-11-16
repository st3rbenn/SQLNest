import { SnqlError } from "../diagnostics";
import type {
	CastTarget,
	DeleteStatement,
	Expr,
	InsertStatement,
	Query,
	UpdateStatement
} from "../parser/ast";
import type { SchemaModel, SnqlType } from "../schema/model";
import { type OuterScope, outerScopeStack } from "./lower-scope";
import { defined } from "../invariant";

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
		const first = defined(pickStage.fields[0]);
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
		const head = defined(path[0]);
		const rest = defined(path[1]);
		// Priorité 1 : alias source current
		if (source.alias === head) {
			const coll = schema.collections.find((c) => c.name === source.collection);
			return coll?.fields.find((f) => f.name === rest)?.type ?? "unknown";
		}
		// Priorité 2 : outer scopes (correlated)
		for (let i = outerScopeStack.length - 1; i >= 0; i -= 1) {
			const outerScope = defined(outerScopeStack[i]);
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
				const subExpr = defined(expr.values[0]);
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
export function typecheckQuery(
	query: Query,
	schema: SchemaModel | undefined
): void {
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
export function typecheckMutation(
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
