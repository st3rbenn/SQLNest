import { SnqlError } from "../diagnostics";
import type { Expr, FieldSelection, Stage } from "../parser/ast";
import type { SchemaModel } from "../schema/model";
import { outerScopeStack } from "./lower-scope";

/**
 * Contrôles des colonnes et des alias cités par une requête : alias défini,
 * colonne disponible à ce point du pipeline, suggestion de la plus proche.
 */

/**
 * Un `alias.field` en pick/where/sort où `alias` a été introduit par un `with`
 * en mode `embed` (one-to-many / many-to-many) n'a pas de valeur unique — le
 * codegen ne peut pas le traduire proprement. On lève ici une erreur explicite
 * plutôt que de laisser Postgres/Mongo remonter un message obscur.
 */
export function checkNoEmbedAliasDeref(
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
export function checkAliasDefined(
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
 * Construit `sourceColumns` depuis le schéma — retourne `null` (permissif)
 * quand la source n'est pas dans le schéma ou n'a pas de fields listés.
 * Partagé entre [[lower]] (reads) et [[lowerMutation]] (writes).
 */
export function resolveSourceColumns(
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
export function checkExprPathsAgainstColumns(
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
export function closestColumnHint(
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

/** Noms de sortie d'un `pick` = alias, sinon dernier segment du chemin. */
export function projectionKeys(
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
export function checkColumnsAvailable(
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
export function stripAlias(
	path: readonly string[],
	alias: string | undefined
): readonly string[] {
	return alias !== undefined && path.length > 1 && path[0] === alias
		? path.slice(1)
		: path;
}
