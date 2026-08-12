import type { OperationKind } from "../lexer/dictionary";
import type { Span } from "../lexer/token";

export type { OperationKind };

export type CompareOperator = "=" | "!=" | "<" | ">" | "<=" | ">=" | "like";

/** Opérateurs arithmétiques binaires (Slice T1 — extension du Pratt parser). */
export type ArithOperator = "+" | "-" | "*" | "/" | "%";

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
	| {
			readonly type: "call";
			readonly name: string;
			readonly args: readonly Expr[];
			readonly span: Span;
	  };

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

export type Stage =
	| { readonly type: "where"; readonly predicate: Expr; readonly span: Span }
	| {
			readonly type: "pick";
			readonly fields: readonly FieldSelection[];
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

/** `update <coll> [where <pred>] set <affectations>`. `where` optionnel : sans lui, toutes les lignes. */
export interface UpdateStatement {
	readonly operation: "update";
	readonly verb: string;
	readonly collection: string;
	readonly predicate?: Expr;
	readonly assignments: readonly Assignment[];
	readonly span: Span;
}

/** `remove from <coll> [| where <pred>]`. `where` optionnel : sans lui, toutes les lignes. */
export interface DeleteStatement {
	readonly operation: "delete";
	readonly verb: string;
	readonly collection: string;
	readonly predicate?: Expr;
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

/** `add {doc} into <coll>` ou `add [{…}, {…}] into <coll>`. */
export interface InsertStatement {
	readonly operation: "insert";
	readonly verb: string;
	readonly collection: string;
	readonly rows: readonly InsertRow[];
	readonly span: Span;
}

/** Racine de l'AST : lecture (`Query`) ou mutation. */
export type Statement =
	| Query
	| InsertStatement
	| UpdateStatement
	| DeleteStatement;
