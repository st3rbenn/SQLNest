import type { OperationKind } from "../lexer/dictionary";
import type { Span } from "../lexer/token";

export type { OperationKind };

export type CompareOperator = "=" | "!=" | "<" | ">" | "<=" | ">=" | "like";

/** Opérateurs arithmétiques binaires (Slice T1 — extension du Pratt parser). */
export type ArithOperator = "+" | "-" | "*" | "/" | "%";

/**
 * Types canoniques SNQL pour `cast(x as T)` (T2 sprint 2). Surface fermée : la
 * whitelist force une seule orthographe par type (pas d'alias SQL type
 * `integer`/`string`/`varchar` — le parser oriente le dev vers ces 7).
 */
export type CastTarget =
	| "int"
	| "float"
	| "text"
	| "bool"
	| "date"
	| "timestamp"
	| "json";

export const CAST_TARGETS: ReadonlySet<CastTarget> = new Set<CastTarget>([
	"int",
	"float",
	"text",
	"bool",
	"date",
	"timestamp",
	"json"
]);

export type LiteralValue =
	// Le littéral numérique garde son texte brut (`raw`) pour ne pas perdre en
	// précision avant le codegen (cf. entiers > 2^53).
	| { readonly kind: "number"; readonly raw: string }
	| { readonly kind: "string"; readonly value: string }
	| { readonly kind: "boolean"; readonly value: boolean }
	| { readonly kind: "null" };

/** Arbre d'expression fidèle à la surface (utilisé dans `where`). */
export type Expr =
	| {
			readonly type: "literal";
			readonly value: LiteralValue;
			readonly span: Span;
	  }
	| {
			readonly type: "field";
			readonly path: readonly string[];
			readonly span: Span;
	  }
	| {
			readonly type: "compare";
			readonly operator: CompareOperator;
			readonly left: Expr;
			readonly right: Expr;
			readonly span: Span;
	  }
	| {
			readonly type: "logical";
			readonly operator: "and" | "or";
			readonly left: Expr;
			readonly right: Expr;
			readonly span: Span;
	  }
	| { readonly type: "not"; readonly operand: Expr; readonly span: Span }
	| {
			readonly type: "in";
			readonly target: Expr;
			readonly values: readonly Expr[];
			readonly span: Span;
	  }
	// Arithmétique scalaire binaire. Précédence Pratt : `+/-` bp 5, `*//%` bp 6
	// (au-dessus de `compare/in/like`=4 pour que `where age * 2 > 30` groupe bien).
	| {
			readonly type: "arith";
			readonly operator: ArithOperator;
			readonly left: Expr;
			readonly right: Expr;
			readonly span: Span;
	  }
	// Appel de fonction — `upper(name)`, `now()`, `coalesce(a, b, c)`. Le nom est
	// case-normalisé (lowercase) dès la construction. Résolu au lower via le
	// registre de fonctions ; arité + typage vérifiés là.
	//
	// Sprint T2/6 : deux flags optionnels pour les aggregates.
	//  - `star` : `count(*)` — args=[] (invariant vérifié au parser + lower).
	//  - `unique` : `count(unique x)` — args.length=1 (invariant vérifié au
	//    parser + lower). Réservé aux aggregates ; les scalaires refusent.
	//
	// Sprint T2/8 : `sortKeys?` — sort intra-call pour aggregateMulti
	// (`string_agg(name, ", " sort name asc)`). Parser contextuel via registre :
	// accepté uniquement si registre.get(name).kind === 'aggregateMulti'.
	| {
			readonly type: "call";
			readonly name: string;
			readonly args: readonly Expr[];
			readonly star?: true;
			readonly unique?: true;
			readonly sortKeys?: readonly SortKey[];
			readonly span: Span;
	  }
	// Cast explicite `cast(expr as T)` — T ∈ CAST_TARGETS. Surface distincte du
	// call node (pas dans le registre) pour ne pas polluer l'assertion write et
	// laisser passer les casts en set/update (déterministes, NULL propagate).
	| {
			readonly type: "cast";
			readonly operand: Expr;
			readonly target: CastTarget;
			readonly targetSpan: Span;
			readonly span: Span;
	  }
	// Object literal en position d'expression : `{n: "hello", s: 42, arr: [1, 2]}`.
	// Retour statique type `json`. Composition naturelle avec json_get_text /
	// json_contains / cast interdit (planner refus). Débloque le workaround
	// `cast("{\\"n\\":1}" as json)` (raw JSON déguisé, violait "raw JAMAIS fallback").
	| {
			readonly type: "object";
			readonly entries: readonly ObjectEntry[];
			readonly span: Span;
	  }
	// Array literal en position d'expression : `[10, 20, 30]` ou `[r.id, r.name]`.
	// Retour statique `json`. Réutilisable dans une value d'insert (widening
	// PlanRowValue). Expr.in reste dédié pour `where x in [...]` (garde le
	// fast-path indexable dot-notation Mongo).
	| {
			readonly type: "array";
			readonly items: readonly Expr[];
			readonly span: Span;
	  }
	// Sprint T2/5 : structure conditionnelle `case { c1 -> v1, c2 -> v2, else -> v3 }`.
	// Else obligatoire à la surface (pas de NULL implicite). First-match wins.
	// PG codegen : CASE WHEN. Mongo codegen : $switch. Runtime KV : short-circuit
	// évaluation lazy (parité PG 3VL, cond === true strict).
	| {
			readonly type: "case";
			readonly branches: readonly CaseBranch[];
			readonly elseValue: Expr;
			readonly span: Span;
	  }
	// Sprint T2/9 : window function — `fn(args) over (partition <col> sort <key>)`.
	// Distinct de `call` : sémantique différente (assign per-row basé sur
	// partition context, pas per-row scalaire ni fold), lifecycle IR distinct
	// (codegen Mongo insère un $setWindowFields avant $project ; PG émet
	// OVER clause dans SELECT ; KV pre-processing runtime). `partitionKeys` et
	// `sortKeys` optionnels (vide = OVER toute la relation).
	| {
			readonly type: "windowCall";
			readonly name: string;
			readonly args: readonly Expr[];
			readonly partitionKeys: readonly (readonly string[])[];
			readonly sortKeys: readonly SortKey[];
			readonly span: Span;
	  }
	// Sprint T2/11 : sub-query uncorrelated — `(find t pick y)` en position
	// d'expression, typiquement à droite d'un `in` ou wrappé par `exists`.
	// La `query` est une full Query nested (parsée récursivement). Uncorrelated
	// = pas de scope-lookup vers les alias de la query outer (T2/12 correlated
	// introduira ScopeStack).
	| {
			readonly type: "subquery";
			readonly query: Query;
			readonly span: Span;
	  }
	// Sprint T2/11 : EXISTS prefix — `exists (find ...)`. Le subquery est
	// TOUJOURS un Expr.subquery (invariant vérifié au parser). Retourne bool
	// (true si la subquery renvoie au moins une row).
	| {
			readonly type: "exists";
			readonly subquery: Expr;
			readonly span: Span;
	  };

/**
 * Branche d'un `case { cond -> value, … }`. `cond` doit être une expression
 * booléenne (garde `lower_case_cond_type` au lower refuse les literals
 * object/array/number/string non-bool).
 */
export interface CaseBranch {
	readonly cond: Expr;
	readonly value: Expr;
	readonly span: Span;
}

/** Profondeur max d'imbrication `case { … }` — protection stack overflow parser. */
export const MAX_CASE_DEPTH = 32;

/**
 * Une entrée d'object literal — `key: value` avec key en ident (bare) ou
 * string (quoted). `keyQuoted` permet le round-trip fidèle au formatter.
 * Réutilisable comme shape unifié pour parseInsertField (voir wrapper dans
 * parser.ts qui produit InsertField {column, value, span} depuis ObjectEntry).
 */
export interface ObjectEntry {
	readonly key: string;
	readonly keyQuoted: boolean;
	readonly value: Expr;
	readonly keySpan: Span;
	readonly span: Span;
}

/** Profondeur max d'imbrication object/array — protection stack overflow parser. */
export const MAX_LITERAL_DEPTH = 64;

/**
 * Élément d'un `pick`. Soit un chemin de champ simple (`u.name`, `id`), soit une
 * expression calculée (`price * qty`, `upper(name)`). Une expression exige un
 * `alias` — il n'y a pas de nom naturel à déduire du calcul.
 */
export interface FieldSelection {
	/** Chemin, vide si `expr` est présent. */
	readonly path: readonly string[];
	/** Expression calculée — prioritaire sur `path`. Requiert un `alias`. */
	readonly expr?: Expr;
	readonly alias?: string;
	readonly span: Span;
}

export interface SortKey {
	readonly path: readonly string[];
	readonly direction: "asc" | "desc";
	readonly span: Span;
}

export interface GroupKey {
	readonly path: readonly string[];
	readonly span: Span;
}

export type Stage =
	| { readonly type: "where"; readonly predicate: Expr; readonly span: Span }
	// Sprint T2/10 : DISTINCT via `pick unique <fields>` (dédup sur tous les
	// fields projetés) ou `pick unique on (<keys>) <fields>` (DISTINCT ON
	// avec keys explicites, parens obligatoires). Les 2 sont exclusifs avec
	// `group by` (refus lower_unique_with_group).
	| {
			readonly type: "pick";
			readonly fields: readonly FieldSelection[];
			readonly unique?: true;
			readonly distinctOnKeys?: readonly (readonly string[])[];
			readonly span: Span;
	  }
	| {
			readonly type: "sort";
			readonly keys: readonly SortKey[];
			readonly span: Span;
	  }
	| {
			readonly type: "limit";
			readonly count: number;
			readonly offset?: number;
			readonly span: Span;
	  }
	| {
			readonly type: "with";
			readonly collection: string;
			readonly alias?: string;
			readonly localField: readonly string[];
			readonly foreignField: readonly string[];
			/**
			 * Multiplicité **forcée** par l'utilisateur (`with one X` / `with many X`).
			 * Absent = inférence via [[SchemaModel]] au lower (relations → embed/join).
			 * Sert d'escape hatch quand l'inférence rate ou n'a pas de schéma.
			 */
			readonly multiplicity?: "one" | "many";
			readonly span: Span;
	  }
	| {
			readonly type: "group";
			readonly keys: readonly GroupKey[];
			readonly span: Span;
	  }
	| {
			readonly type: "having";
			readonly predicate: Expr;
			readonly span: Span;
	  };

export interface Source {
	readonly collection: string;
	readonly alias?: string;
	readonly span: Span;
}

/** Racine de l'AST d'une requête de **lecture** SNQL. */
export interface Query {
	readonly operation: "select";
	readonly verb: string;
	readonly source: Source;
	readonly stages: readonly Stage[];
	readonly span: Span;
}

/** Une affectation d'un `set` : `<colonne> = <valeur>`. */
export interface Assignment {
	readonly column: string;
	readonly value: Expr;
	readonly span: Span;
}

/**
 * Sprint T2/13 : action à effectuer quand l'insert entre en conflit sur les
 * `keys` de l'upsert.
 *  - `ignore` : `INSERT ... ON CONFLICT (...) DO NOTHING`.
 *  - `update` : `INSERT ... ON CONFLICT (...) DO UPDATE SET c = expr [WHERE ...]`.
 *    Les `assignments` peuvent référencer la row proposée via le pseudo-alias
 *    `new.<col>` (transformé en PlanExpr.upsertNew au lower) et la row existante
 *    via le champ bare (ou `<table>.<col>` — PG résout naturellement).
 */
export type OnConflictAction =
	| { readonly kind: "ignore"; readonly span: Span }
	| {
			readonly kind: "update";
			readonly assignments: readonly Assignment[];
			readonly where?: Expr;
			readonly span: Span;
	  };

/**
 * Sprint T2/13 : clause `on conflict (k1, k2) [ignore | edit set ... [where ...]]`
 * portée par un `add {…} into t`. Le sprint reste PG-only (capability `upsert`).
 */
export interface OnConflictClause {
	readonly keys: readonly string[];
	readonly action: OnConflictAction;
	readonly span: Span;
}

/** `update <coll> [as <alias>] [with one X on l=f]* [where <pred>] set <affectations> [pick count]`. `where` optionnel : sans lui, toutes les lignes. */
export interface UpdateStatement {
	readonly operation: "update";
	readonly verb: string;
	readonly collection: string;
	// Sprint T2/14 : alias source `update t as a set …` — permet à `set`/`where`
	// de référencer les cols de la source via `a.col` en cohabitant avec les
	// joins qui ont leurs propres alias.
	readonly alias?: string;
	// Sprint T2/14 : joins mutation `update t with one X on l=f set …`. Réutilise
	// la variante `Stage.with` (multiplicity/alias/foreignField portés dedans).
	// `with many` est rejeté au lower (`lower_write_join_many`) pour éviter
	// UPDATE cartésien silencieux ; seul `with one` est autorisé.
	readonly joins?: readonly Stage[];
	readonly predicate?: Expr;
	readonly assignments: readonly Assignment[];
	// Sprint T2/13 : `pick count` — drop `RETURNING *` côté codegen, ne renvoie
	// que rowCount (le front lit `rowCount` sans payload de rows).
	readonly returnRowCount?: true;
	readonly span: Span;
}

/** `remove from <coll> [| where <pred>] [pick count]`. `where` optionnel : sans lui, toutes les lignes. */
export interface DeleteStatement {
	readonly operation: "delete";
	readonly verb: string;
	readonly collection: string;
	readonly predicate?: Expr;
	readonly returnRowCount?: true;
	readonly span: Span;
}

/** Un champ d'un document d'insertion : `column: value`. */
export interface InsertField {
	readonly column: string;
	readonly value: Expr;
	readonly span: Span;
}

/** Un document d'insertion `{ … }`. */
export interface InsertRow {
	readonly fields: readonly InsertField[];
	readonly span: Span;
}

/**
 * `add {doc} into <coll> [on conflict (keys) …] [pick count]` (rows literal)
 * OU `add (find … pick a, b as c) into <coll> [pick count]` (INSERT SELECT).
 * Les 2 formes sont mutuellement exclusives : `rows` est peuplé pour les
 * documents literals, `sourceQuery` pour l'INSERT SELECT. Sprint T2/14 :
 * `sourceQuery` mapping cols inféré du `pick` (`x as tgt_col` → tgt_col).
 */
export interface InsertStatement {
	readonly operation: "insert";
	readonly verb: string;
	readonly collection: string;
	readonly rows: readonly InsertRow[];
	/** Sprint T2/14 : INSERT SELECT — mutuellement exclusif avec `rows` non vide. */
	readonly sourceQuery?: Query;
	readonly onConflict?: OnConflictClause;
	readonly returnRowCount?: true;
	readonly span: Span;
}

/**
 * Sprint T2/15 : niveau d'isolation Postgres. Cast direct au codegen —
 * `BEGIN ISOLATION LEVEL READ COMMITTED` etc. Absent = default du serveur
 * (READ COMMITTED sur PG standard).
 */
export type IsolationLevel = "read_committed" | "repeatable_read" | "serializable";

/**
 * Sprint T2/15 : élément du body d'une transaction — soit un statement
 * classique (select/insert/update/delete), soit un sous-bloc savepoint.
 * Une transaction ne peut PAS contenir une transaction imbriquée (refus
 * parse).
 */
export type TransactionBodyItem =
	| Query
	| InsertStatement
	| UpdateStatement
	| DeleteStatement
	| SavepointStatement;

/**
 * Sprint T2/15 : `savepoint <name> { stmt; stmt; ... }` — bloc atomique
 * dans une transaction. Rollback partiel au savepoint sur erreur, sans
 * casser la transaction englobante.
 */
export interface SavepointStatement {
	readonly operation: "savepoint";
	readonly name: string;
	readonly body: readonly TransactionBodyItem[];
	readonly span: Span;
}

/**
 * Sprint T2/15 : `transaction [isolation <level>] { stmt; stmt; ... }` — bloc
 * atomique multi-statements. PG only v1 (capability `transaction`). Le
 * séparateur `;` est OBLIGATOIRE entre statements (robuste au copier-coller).
 */
export interface TransactionStatement {
	readonly operation: "transaction";
	readonly isolation?: IsolationLevel;
	readonly body: readonly TransactionBodyItem[];
	readonly span: Span;
}

/**
 * Sprint T3/1 : statement d'introspection — `list tables`, `describe <table>`,
 * `list schemas`, `list indexes`, etc. Le `kind` discrimine la sous-commande ;
 * `target` porte l'ident cible quand applicable (ex: `describe users`). Chaque
 * kind est cadré par un mini-schéma (colonnes fixes en sortie) — pas de
 * projection user (contrat SNQL : introspection retourne un shape stable).
 */
export type IntrospectKind =
	| "list-tables" // T3/1 — v1 : liste plate des tables du schéma courant
	| "describe-table"; // T3/2 — colonnes d'une table (name/type/nullable/default/PK/FK)

export interface IntrospectStatement {
	readonly operation: "introspect";
	readonly kind: IntrospectKind;
	readonly target?: string;
	/**
	 * Sprint T3/2.3 : stages classiques (`where`/`pick`/`sort`/`limit`) appliqués
	 * en post-traitement sur le dataset produit par l'introspection. Uniforme
	 * avec `find` — `describe users pick name, type sort name` marche comme
	 * une requête. `with`/`group`/`having` refusés v1 (utilité limitée, coût
	 * lowering élevé).
	 */
	readonly stages?: readonly Stage[];
	readonly span: Span;
}

/** Racine de l'AST : lecture (`Query`), mutation, transaction (T2/15), ou introspection (T3/1). */
export type Statement =
	| Query
	| InsertStatement
	| UpdateStatement
	| DeleteStatement
	| TransactionStatement
	| IntrospectStatement;
