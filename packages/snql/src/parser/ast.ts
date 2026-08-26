import type { OperationKind } from "../lexer/dictionary";
import type { Span } from "../lexer/token";

export type { OperationKind };

export type CompareOperator = "=" | "!=" | "<" | ">" | "<=" | ">=" | "like";

/** Opérateurs arithmétiques binaires (Slice T1 — extension du Pratt parser). */
export type ArithOperator = "+" | "-" | "*" | "/" | "%";

/**
 * Types canoniques SNQL pour `cast(x as T)`. Surface fermée : la
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
	// deux flags optionnels pour les aggregates.
	//  - `star` : `count(*)` — args=[] (invariant vérifié au parser + lower).
	//  - `unique` : `count(unique x)` — args.length=1 (invariant vérifié au
	//    parser + lower). Réservé aux aggregates ; les scalaires refusent.
	//
	// `sortKeys?` — sort intra-call pour aggregateMulti
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
	// structure conditionnelle `case { c1 -> v1, c2 -> v2, else -> v3 }`.
	// Else obligatoire à la surface (pas de NULL implicite). First-match wins.
	// PG codegen : CASE WHEN. Mongo codegen : $switch. Runtime KV : short-circuit
	// évaluation lazy (parité PG 3VL, cond === true strict).
	| {
			readonly type: "case";
			readonly branches: readonly CaseBranch[];
			readonly elseValue: Expr;
			readonly span: Span;
	  }
	// window function — `fn(args) over (partition <col> sort <key>)`.
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
	// sub-query uncorrelated — `(find t pick y)` en position
	// d'expression, typiquement à droite d'un `in` ou wrappé par `exists`.
	// La `query` est une full Query nested (parsée récursivement). Uncorrelated
	// = pas de scope-lookup vers les alias de la query outer (correlated
	// introduira ScopeStack).
	| {
			readonly type: "subquery";
			readonly query: Query;
			readonly span: Span;
	  }
	// EXISTS prefix — `exists (find...)`. Le subquery est
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
	// DISTINCT via `pick unique <fields>` (dédup sur tous les
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
 * action à effectuer quand l'insert entre en conflit sur les
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
 * clause `on conflict (k1, k2) [ignore | edit set... [where...]]`
 * portée par un `add {…} into t`. Reste PG-only (capability `upsert`).
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
	// alias source `update t as a set …` — permet à `set`/`where`
	// de référencer les cols de la source via `a.col` en cohabitant avec les
	// joins qui ont leurs propres alias.
	readonly alias?: string;
	// joins mutation `update t with one X on l=f set …`. Réutilise
	// la variante `Stage.with` (multiplicity/alias/foreignField portés dedans).
	// `with many` est rejeté au lower (`lower_write_join_many`) pour éviter
	// UPDATE cartésien silencieux ; seul `with one` est autorisé.
	readonly joins?: readonly Stage[];
	readonly predicate?: Expr;
	readonly assignments: readonly Assignment[];
	// `pick count` — drop `RETURNING *` côté codegen, ne renvoie
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
 * documents literals, `sourceQuery` pour l'INSERT SELECT. :
 * `sourceQuery` mapping cols inféré du `pick` (`x as tgt_col` → tgt_col).
 */
export interface InsertStatement {
	readonly operation: "insert";
	readonly verb: string;
	readonly collection: string;
	readonly rows: readonly InsertRow[];
	/** INSERT SELECT — mutuellement exclusif avec `rows` non vide. */
	readonly sourceQuery?: Query;
	readonly onConflict?: OnConflictClause;
	readonly returnRowCount?: true;
	readonly span: Span;
}

/**
 * niveau d'isolation Postgres. Cast direct au codegen
 * `BEGIN ISOLATION LEVEL READ COMMITTED` etc. Absent = default du serveur
 * (READ COMMITTED sur PG standard).
 */
export type IsolationLevel =
	| "read_committed"
	| "repeatable_read"
	| "serializable";

/**
 * élément du body d'une transaction — soit un statement
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
 * `savepoint <name> { stmt; stmt; ... }` — bloc atomique
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
 * `transaction [isolation <level>] { stmt; stmt; ... }` — bloc
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
 * statement d'introspection — `list tables`, `describe <table>`,
 * `list schemas`, `list indexes`, etc. Le `kind` discrimine la sous-commande ;
 * `target` porte l'ident cible quand applicable (ex: `describe users`). Chaque
 * kind est cadré par un mini-schéma (colonnes fixes en sortie) — pas de
 * projection user (contrat SNQL : introspection retourne un shape stable).
 */
export type IntrospectKind =
	| "list-tables" // liste plate des tables du schéma courant
	| "describe-table" // colonnes d'une table (name/type/nullable/default/PK/FK)
	| "list-schemas" // schemas PG (namespaces intra-DB) — shape {name}
	| "list-indexes" // indexes, target optionnel — shape {name,table,unique,columns}
	// Mongo-first : listing des databases du cluster. PG refuse au planner
	// (utilise `list schemas` pour les namespaces intra-DB).
	| "list-databases"
	// Table système SQLNest — audit trail des checksums de schéma. Codegen
	// émet un `SqlnestIntrospectQuery` cross-engine, routé backend vers
	// `getCanvasChecksumHistory` (pas la DB user via tunnel).
	| "list-schema-events";

export interface IntrospectStatement {
	readonly operation: "introspect";
	readonly kind: IntrospectKind;
	readonly target?: string;
	/**
	 * stages classiques (`where`/`pick`/`sort`/`limit`) appliqués
	 * en post-traitement sur le dataset produit par l'introspection. Uniforme
	 * avec `find` — `describe users pick name, type sort name` marche comme
	 * une requête. `with`/`group`/`having` refusés v1 (utilité limitée, coût
	 * lowering élevé).
	 */
	readonly stages?: readonly Stage[];
	readonly span: Span;
}

/**
 * escape hatch `raw`. Payload est un texte SQL brut (PG) OU
 * un document JSON qui devient une command MongoDB via db.runCommand.
 * L'ambiguïté PG-vs-Mongo se résout à l'engine cible : le mapper refuse
 * le shape qui n'est pas le sien avec un message dédié.
 */
export type RawPayload =
	| {
			readonly kind: "sql";
			readonly text: string;
			readonly textSpan: Span;
	  }
	| {
			readonly kind: "mongo";
			readonly command: Expr; // Expr.object au parser — évalué au lower.
			readonly commandSpan: Span;
	  };

/**
 * `raw "SELECT..."` (PG) ou `raw {aggregate: "u", ...}` (Mongo).
 * Bypass le pipeline SNQL — aucun stage n'est autorisé après. Contract :
 * l'utilisateur assume la sécurité (pas de bind auto v1), les capabilities
 * du rôle DB gouvernent read/write (SNQL ne re-check pas).
 */
export interface RawStatement {
	readonly operation: "raw";
	readonly payload: RawPayload;
	readonly span: Span;
}

/**
 * un binding `let <name> = <query>` (kind: 'plain') ou
 * `let rec <name> = <base> union all <step>` (kind: 'recursive'). Toujours
 * une Query (select) — un CTE n'a de sens qu'en lecture. Peut référencer les
 * bindings précédents (ordre topologique validé au lower). Discriminated union
 * pour survivre au JSON round-trip du store fullscreen (un champ optionnel
 * `recursive?` disparaît au serialize).
 */
export type LetBinding = {
	readonly name: string;
	readonly span: Span;
} & (
	| { readonly kind: "plain"; readonly query: Query }
	| {
			readonly kind: "recursive";
			readonly base: Query;
			readonly step: Query;
	  }
);

/**
 * wrapper `let x1 = ...; let x2 = ...; <body>`. Le body accepte
 * find/add/update/remove — toute la DML classique peut consommer les CTE
 * définis en tête (subqueries, joins, insert-select, where in ...). Transaction/
 * raw/introspection sont refusés au parser (pas de sémantique claire v1).
 * Le CTE reste IMMUTABLE : écrire dedans (`add into <cte>`, `update <cte>`,
 * `remove from <cte>`) est refusé au lower.
 */
export interface LetStatement {
	readonly operation: "let";
	readonly bindings: readonly LetBinding[];
	readonly body: Query | InsertStatement | UpdateStatement | DeleteStatement;
	readonly span: Span;
}

/**
 * Corpus DDL Tier-2 — voir [[ADR-029 — SNQL Langage Unifié Tier-2 DDL]]. Chaque
 * kind est une opération atomique modifiant le schéma DB. Discriminated union
 * par kind. V1 (DDL/1) livre `create-table` cross-engine PG + Mongo + KV ; les
 * autres kinds seront ajoutés au fil des sprints DDL/2..DDL/4.
 */
export type DDLKind =
	| "create-table"
	| "drop-table"
	| "add-column"
	| "drop-column"
	| "add-index"
	| "add-unique-index"
	| "drop-index"
	| "create-enum"
	| "add-enum-member"
	| "drop-enum";

/**
 * Un type de field dans un body `create table` ou dans `add column`. Soit un
 * builtin `SnqlType`, soit une référence à un enum nommé (ADR-030) — le
 * parser produit ce shape sans lookup schema ; le lower résout `enum-ref`
 * via `schema.enums`.
 */
export type DDLFieldTypeRef =
	| { readonly kind: "builtin"; readonly type: import("../schema/model").SnqlType }
	| { readonly kind: "enum-ref"; readonly name: string };

/**
 * Field d'un `create table` — le body `{ field: type [nullable] [default v] [unique], ... }`
 * (exception D0 ADR-029 à Grammar v2). Type builtin ou enum-ref
 * (ADR-030) — la résolution se fait au lower via `schema.enums`.
 */
export interface DDLFieldDef {
	readonly name: string;
	readonly type: DDLFieldTypeRef;
	readonly typeSpan: Span;
	readonly nullable?: boolean;
	readonly defaultExpr?: Expr;
	readonly unique?: boolean;
	readonly span: Span;
}

/**
 * `create table T [if not exists] { field: type ..., primary key (fields) } [into <namespace>]`.
 * D3 `if not exists` = name-only cross-engine (drift schéma NON détecté).
 * D13 primary key : PG natif, Mongo alias `_id` single-field ou compound
 * unique, KV refus planner. Escape identifiers D1 au lower.
 */
export interface CreateTableStmt {
	readonly operation: "ddl";
	readonly kind: "create-table";
	readonly target: string;
	readonly ifNotExists?: boolean;
	readonly fields: readonly DDLFieldDef[];
	readonly primaryKey?: readonly string[];
	readonly span: Span;
}

/**
 * `add column <col> <type> [nullable] [default <val>] into <table>` (DDL/2).
 * Préposition unifiée `into` (D6 ADR-029). Backfill obligatoire cross-engine
 * (D10) : PG natif via `DEFAULT v`, Mongo compensation runtime `updateMany`
 * batched, KV `SCAN + HSET`. D2 : `add column NOT NULL` sans default →
 * preflight Mongo `countDocuments {$exists:false}` avant `collMod`, refus
 * runtime typé si > 0 (pattern PA/5).
 */
export interface AddColumnStmt {
	readonly operation: "ddl";
	readonly kind: "add-column";
	readonly target: string;
	readonly column: DDLFieldDef;
	readonly ifNotExists?: boolean;
	readonly span: Span;
}

/**
 * `add [unique] index (<field>[, ...]) [if not exists] into <table>` (DDL/3).
 * Préposition unifiée `into` (D6). D11 PG : `CREATE INDEX CONCURRENTLY` par
 * défaut (refus in-tx natif PG). D12 KV : compensation via write-middleware
 * SETNX si `unique`. `name` est optionnel — auto-généré au lower si absent
 * (pattern `idx_<table>_<f1_f2>` / `unique_<table>_<f1_f2>`).
 */
export interface AddIndexStmt {
	readonly operation: "ddl";
	readonly kind: "add-index" | "add-unique-index";
	readonly target: string;
	readonly fields: readonly string[];
	readonly ifNotExists?: boolean;
	readonly name?: string;
	readonly span: Span;
}

/**
 * `drop index <name> from <table> [if exists]` (DDL/3). Préposition unifiée
 * `from` (D6). Le nom est explicite — l'user doit passer par `list indexes`
 * pour retrouver un nom auto-généré si besoin.
 */
export interface DropIndexStmt {
	readonly operation: "ddl";
	readonly kind: "drop-index";
	readonly target: string;
	readonly name: string;
	readonly ifExists?: boolean;
	readonly span: Span;
}

/**
 * `drop table <name> [if exists]` (DDL/4). Destructif — le frontend applique
 * D7 typing UI gate (WriteConfirmBar « tape DROP pour confirmer »). D3
 * idempotence via `ifExists`. PG DROP TABLE RESTRICT par défaut (safe vs FK).
 */
export interface DropTableStmt {
	readonly operation: "ddl";
	readonly kind: "drop-table";
	readonly target: string;
	readonly ifExists?: boolean;
	readonly span: Span;
}

/**
 * `drop column <col> from <table> [if exists]` (DDL/4). Destructif — D7
 * typing UI gate frontend. Compensation Mongo/KV : collMod validator (retire
 * property) + updateMany `$unset` / SCAN + HDEL batched (pattern miroir D10
 * backfill), pour purger la valeur dans les docs existants.
 */
export interface DropColumnStmt {
	readonly operation: "ddl";
	readonly kind: "drop-column";
	readonly target: string;
	readonly column: string;
	readonly ifExists?: boolean;
	readonly span: Span;
}

/**
 * `create enum <name> { "m1", "m2", ... } [if not exists]` (ADR-030 Enum/1).
 * Type énum nommé, scope per-schema (Q3 tranché). Members = string literals
 * uniquement (Q2 D2). Cross-engine : PG `CREATE TYPE AS ENUM` natif, Mongo
 * `_snql_enums` metadata + validator, KV `HSET _snql_enums` + middleware.
 * L'inline union `type: string in ("a", "b")` est refusé (Q4 tranché) —
 * force nommer l'enum.
 */
export interface CreateEnumStmt {
	readonly operation: "ddl";
	readonly kind: "create-enum";
	readonly name: string;
	readonly members: readonly string[];
	readonly ifNotExists?: boolean;
	readonly span: Span;
}

/**
 * `add enum member <Name> "member" [if not exists]` (ADR-030 Enum/3). Append-only
 * safe cross-engine — PG `ALTER TYPE ADD VALUE IF NOT EXISTS` natif, Mongo
 * patch `_snql_enums` + collMod batched sur les collections utilisatrices,
 * KV patch `_snql_enums`. `ifNotExists` implicite (D3 idempotent silence
 * si member déjà présent — même comportement sans le modifier).
 */
export interface AddEnumMemberStmt {
	readonly operation: "ddl";
	readonly kind: "add-enum-member";
	readonly name: string;
	readonly member: string;
	readonly memberSpan: Span;
	readonly ifNotExists?: boolean;
	readonly span: Span;
}

/**
 * `drop enum <name> [if exists] [cascade]` (ADR-030 Enum/3, D8). Destructif —
 * D7 typing UI gate frontend (`WriteConfirmBar` « tape DROP <name> pour
 * confirmer »). RESTRICT par défaut (PG natif) — refuse si l'enum est utilisé
 * par ≥1 table. CASCADE explicite drop les colonnes dépendantes (équivalent
 * SQL standard). Mongo compense (delete metadata + rollback validators sur
 * collections utilisatrices), KV `HDEL _snql_enums`.
 */
export interface DropEnumStmt {
	readonly operation: "ddl";
	readonly kind: "drop-enum";
	readonly name: string;
	readonly ifExists?: boolean;
	readonly cascade?: boolean;
	readonly span: Span;
}

/**
 * Union des statements DDL. Corpus Tier-2 (create-table/add-column/[add-|
 * drop-]index/drop-table/drop-column) + Enum Tier-3+ (create-enum/
 * add-enum-member/drop-enum).
 */
export type DDLStatement =
	| CreateTableStmt
	| AddColumnStmt
	| AddIndexStmt
	| DropIndexStmt
	| DropTableStmt
	| DropColumnStmt
	| CreateEnumStmt
	| AddEnumMemberStmt
	| DropEnumStmt;

/** Racine de l'AST : lecture (`Query`), mutation, transaction, introspection, raw, let/CTE ou DDL Tier-2. */
export type Statement =
	| Query
	| InsertStatement
	| UpdateStatement
	| DeleteStatement
	| TransactionStatement
	| IntrospectStatement
	| RawStatement
	| LetStatement
	| DDLStatement;
