import { SnqlError } from "../diagnostics";
import { checkArity, SNQL_FUNCTIONS } from "../functions";
import { CAST_TARGETS } from "../parser/ast";
import type {
	CastTarget,
	CompareOperator,
	DeleteStatement,
	Expr,
	FieldSelection,
	InsertStatement,
	LiteralValue,
	Query,
	SortKey,
	Stage,
	UpdateStatement
} from "../parser/ast";
import type { Relation, RelationKind, SchemaModel } from "../schema/model";
import type {
	CompareOp,
	LogicalPlan,
	MutationPlan,
	PlanExpr,
	PlanProjectField,
	PlanSortKey,
	SqlValue
} from "./plan";

/**
 * Abaisse l'AST de surface en Logical Plan canonique (collapse des synonymes, etc.).
 *
 * Le [[SchemaModel]] optionnel permet d'inférer la multiplicité des joins `with`
 * depuis les relations introspectées : une relation many-to-one/one-to-one produit
 * un vrai LEFT JOIN (`kind: "join"`), une one-to-many/many-to-many produit un
 * embed en array (`kind: "embed"`). Sans schéma ou sans relation matchante, on
 * retombe sur `embed` (comportement historique). L'utilisateur peut forcer via
 * `with one X` / `with many X`.
 */
export function lower(query: Query, schema?: SchemaModel): LogicalPlan {
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
	for (const stage of query.stages) {
		checkColumnsAvailable(stage, available);
		if (stage.type !== "with") {
			checkNoEmbedAliasDeref(stage, embedAliases);
		}
		if (sourceColumns !== null) {
			checkAliasDefined(stage, knownAliases, sourceColumns, query.source);
		}
		plan = lowerStage(plan, stage, query.source.collection, query.source.alias, schema);
		if (stage.type === "pick") {
			available = projectionKeys(stage.fields);
		} else if (stage.type === "with") {
			// Le join ajoute un champ imbriqué (`as`) aux colonnes disponibles.
			if (available !== null) {
				available = new Set([...available, stage.alias ?? stage.collection]);
			}
			// Le kind vient d'être décidé dans lowerStage — le plan racine est
			// forcément un `join` maintenant.
			if (plan.op === "join" && plan.kind === "embed") {
				embedAliases.add(stage.alias ?? stage.collection);
			}
			// L'alias `with` devient valide pour tout stage suivant.
			knownAliases.add(stage.alias ?? stage.collection);
		}
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
			collectExprFields(stage.predicate, referenced);
			break;
		case "sort":
			for (const key of stage.keys) referenced.push(key.path);
			break;
		case "pick":
			for (const field of stage.fields) referenced.push(field.path);
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
			collectExprFieldsWithSpans(stage.predicate, referenced);
			break;
		case "sort":
			for (const key of stage.keys) {
				referenced.push({ path: key.path, span: key.span });
			}
			break;
		case "pick":
			for (const field of stage.fields) {
				// Un `pick` peut porter une expression (arith, call) sans path direct —
				// on descend dans son expr pour collecter les field refs internes.
				if (field.expr !== undefined) {
					collectExprFieldsWithSpans(field.expr, referenced);
				} else if (field.path.length > 0) {
					referenced.push({ path: field.path, span: field.span });
				}
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
export function lowerMutation(
	statement: InsertStatement | UpdateStatement | DeleteStatement,
	schema?: SchemaModel
): MutationPlan {
	if (statement.operation === "insert") {
		return lowerInsert(statement);
	}
	const sourceColumns = resolveSourceColumns(schema, statement.collection);
	if (statement.operation === "update") {
		assertUniqueAssignments(statement.assignments);
		if (sourceColumns !== null) {
			for (const a of statement.assignments) {
				checkExprPathsAgainstColumns(
					a.value,
					sourceColumns,
					statement.collection
				);
			}
			if (statement.predicate !== undefined) {
				checkExprPathsAgainstColumns(
					statement.predicate,
					sourceColumns,
					statement.collection
				);
			}
		}
		const assignments = statement.assignments.map((assignment) => ({
			column: assignment.column,
			value: lowerExpr(assignment.value)
		}));
		for (const a of assignments) assertNoCallInWrite(a.value);
		const predicate =
			statement.predicate !== undefined ? lowerExpr(statement.predicate) : undefined;
		if (predicate !== undefined) assertNoCallInWrite(predicate);
		return predicate !== undefined
			? {
					op: "update",
					collection: statement.collection,
					assignments,
					predicate
				}
			: { op: "update", collection: statement.collection, assignments };
	}
	if (sourceColumns !== null && statement.predicate !== undefined) {
		checkExprPathsAgainstColumns(
			statement.predicate,
			sourceColumns,
			statement.collection
		);
	}
	const predicate =
		statement.predicate !== undefined ? lowerExpr(statement.predicate) : undefined;
	if (predicate !== undefined) assertNoCallInWrite(predicate);
	return predicate !== undefined
		? {
				op: "delete",
				collection: statement.collection,
				predicate
			}
		: { op: "delete", collection: statement.collection };
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
 */
function checkExprPathsAgainstColumns(
	expr: Expr,
	sourceColumns: ReadonlySet<string>,
	collection: string
): void {
	const referenced: {
		readonly path: readonly string[];
		readonly span: import("../lexer/token").Span;
	}[] = [];
	collectExprFieldsWithSpans(expr, referenced);
	for (const { path, span } of referenced) {
		if (path.length < 2) continue;
		const head = path[0] ?? "";
		if (sourceColumns.has(head)) continue;
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
 * T2 sprint 1 : les fonctions n'ont pas encore de `nullBehavior` déclaré, ce
 * qui rendrait leur sémantique 3VL prévisible en négation Mongo (parité avec
 * la garde champ↔champ existante). En attendant, on refuse tout `call` en
 * contexte write (predicate d'update/delete + valeurs de set) — non-breaking
 * quand on musclera avec `nullBehavior` plus tard.
 */
function assertNoCallInWrite(expr: PlanExpr): void {
	switch (expr.kind) {
		case "call":
			throw new SnqlError(
				`Fonction '${expr.name}' non autorisée dans un contexte d'écriture (update/remove) tant que sa sémantique NULL n'est pas déclarée`,
				"lower_call_null_write"
			);
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
function lowerInsert(statement: InsertStatement): MutationPlan {
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
	const cellSpans: (readonly (import("../lexer/token").Span | undefined)[])[] = [];
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

	return {
		op: "insert",
		collection: statement.collection,
		columns,
		rows,
		rowSpans,
		cellSpans
	};
}

/** Une valeur d'insertion doit être un littéral (nombre, chaîne, booléen, null). */
function literalOf(value: Expr, column: string): SqlValue {
	if (value.type !== "literal") {
		throw new SnqlError(
			`La valeur de '${column}' doit être un littéral (nombre, chaîne, booléen, null)`,
			"lower_insert_non_literal"
		);
	}
	return literalToValue(value.value);
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
				if (field.expr !== undefined) {
					collectExprFields(field.expr, referenced);
				} else {
					referenced.push(field.path);
				}
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
	schema: SchemaModel | undefined
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
		case "in":
			return {
				kind: "in",
				target: lowerExpr(expr.target),
				values: expr.values.map(lowerExpr),
				span: expr.span
			};
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
			// Span de l'operand pour cibler PG 22P02 (`invalid input syntax for … : "X"`)
			// sur le fragment fautif — pas sur le mot-clé `cast`.
			return {
				kind: "cast",
				target: expr.target as CastTarget,
				operand,
				span: operand.span ?? expr.span
			};
		}
	}
}

/**
 * Résout un appel de fonction contre le registre : fonction connue, arité
 * conforme, kind non-`reserved`. Types opt-in : si `entry.args` est déclaré et
 * que l'arg correspondant est statiquement typable (littéral), on vérifie.
 */
function lowerCall(expr: Expr & { type: "call" }): PlanExpr {
	const entry = SNQL_FUNCTIONS.get(expr.name);
	if (entry === undefined) {
		throw new SnqlError(
			`Fonction '${expr.name}' inconnue`,
			"lower_unknown_function",
			expr.span
		);
	}
	if (entry.kind === "reserved") {
		throw new SnqlError(
			`Fonction '${expr.name}' réservée pour un sprint futur — pas encore implémentée`,
			"lower_call_reserved",
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
	return {
		kind: "call",
		name: expr.name,
		args: expr.args.map(lowerExpr),
		span: expr.span
	};
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
