import type { OperationKind } from "../lexer/dictionary";
import type { Span } from "../lexer/token";

export type { OperationKind };

export type CompareOperator = "=" | "!=" | "<" | ">" | "<=" | ">=" | "like";

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
	  };

export interface FieldSelection {
	readonly path: readonly string[];
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
			readonly span: Span;
	  };

export interface Source {
	readonly collection: string;
	readonly alias?: string;
	readonly span: Span;
}

/** Racine de l'AST d'une requête SNQL. */
export interface Query {
	readonly operation: OperationKind;
	readonly verb: string;
	readonly source: Source;
	readonly stages: readonly Stage[];
	readonly span: Span;
}
