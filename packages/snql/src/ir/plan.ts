/**
 * IR / Logical Plan : l'algèbre canonique, engine-agnostique.
 * Chaque opérateur déclare la capacité qu'il exige (voir le vault :
 * `02 - Architecture/The Hard Version — Algèbre Polyglotte`).
 */

import { CAST_TARGETS, type CastTarget } from "../parser/ast";
import type { Span } from "../lexer/token";

export { CAST_TARGETS, type CastTarget };

export type Capability =
	| "scan"
	| "filter"
	| "project"
	| "join"
	| "aggregate"
	| "sort"
	| "paginate"
	| "mutate"
	| "graph"
	// support des sub-queries inline (`in (find...)` /
	// `exists (find ...)`). PG only v1 (natif SQL) ; Mongo/KV refusés.
	| "subquery"
	// `add {…} into t on conflict (col) [ignore | edit set …]`.
	// PG only v1 (INSERT ... ON CONFLICT natif). Mongo/KV refusés (sémantique
	// upsert Mongo est différente — updateOne(upsert:true) sur un full doc,
	// pas de WHERE côté conflict, à réévaluer plus tard).
	| "upsert"
	// `update t with one X on l=f set …` — UPDATE... FROM natif
	// PG. Mongo/KV refusés v1 (Mongo n'a pas de write-join natif ; passe par
	// aggregation + $merge dans les versions récentes, à réévaluer plus tard).
	| "write-join"
	// `add (find … pick a, b) into t` — INSERT INTO... SELECT
	// natif PG. Mongo passe par aggregate + $merge $out, KV pas de select-
	// then-insert atomique — refusés v1.
	| "insert-select"
	// `transaction [isolation …] { stmt; stmt }` bloc atomique
	// multi-statements. PG only v1 (BEGIN/COMMIT/ROLLBACK natif). Mongo/KV
	// hors scope pour l'instant.
	| "transaction"
	// introspection (`list tables`, `describe <t>`, `list
	// schemas`, `list indexes`). PG + Mongo v1 — chaque engine mappe vers
	// son propre mécanisme (information_schema PG, listCollections Mongo).
	// Chaque IntrospectKind renvoie un shape de colonnes stable cross-engine
	// (ex: list-tables → {name: string}).
	| "introspect"
	// `let x = ...; body` — CTE (Common Table Expressions).
	// PG only v1 (WITH ... natif). Mongo pourrait matérialiser via $lookup
	// sub-pipeline mais complexité pas justifiée v1 — refus explicit.
	| "cte"
	// `let rec X = base union all step;` — CTE récursif. PG only
	// (WITH RECURSIVE natif). Mongo/KV refusés au planner (pas de fallback
	// matérialisation runtime — coûteux pour de la récursion arborescente).
	| "cte-recursive"
	// DDL Tier-2 (ADR-029). Grossière : l'adapter connaît AU MOINS un
	// kind DDL. Granularité fine par (kind, engine) dans `DDL_SUPPORT` +
	// `isDDLSupported`. Chaque cellule est native OU compensated — la doctrine
	// Hard Version + PA/1-8 impose aucun refus « engine gap ».
	| "ddl";

/**
 * Décimal **exact** : on garde le texte brut. Les colonnes NUMERIC/DECIMAL de
 * Postgres sont à précision arbitraire, hors de portée d'un double JS — un
 * littéral fractionnaire ne doit JAMAIS passer par `Number()` avant le codegen
 * (sinon corruption silencieuse). Le codegen PG binde le raw (cast exact) ;
 * Mongo / runtime le ramènent à un `number` (limite intrinsèque de JS/BSON).
 */
export interface SqlDecimal {
	readonly kind: "decimal";
	readonly raw: string;
}

/**
 * Valeur scalaire canonique. `bigint` préserve les entiers > 2^53 (clés bigint
 * Postgres, IDs Snowflake) ; `SqlDecimal` préserve les décimaux exacts.
 */
export type SqlValue = string | number | bigint | boolean | null | SqlDecimal;

/** Garde-type sûr, y compris sur un `unknown` arbitraire (row values). */
export function isSqlDecimal(value: unknown): value is SqlDecimal {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as { kind?: unknown }).kind === "decimal" &&
		typeof (value as { raw?: unknown }).raw === "string"
	);
}

// Object/array literal en position de `default` sur un field `type: json` —
// PG bind `'raw'::jsonb`, Mongo/KV ré-injectent `parsed` natif au backfill.
// Restreint à `type: json` : les autres types refusent en amont (lower).
export interface SqlJsonLiteral {
	readonly kind: "json";
	readonly raw: string;
	readonly parsed: unknown;
}

export type DdlDefault = SqlValue | SqlJsonLiteral;

export function isSqlJsonLiteral(value: unknown): value is SqlJsonLiteral {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as { kind?: unknown }).kind === "json" &&
		typeof (value as { raw?: unknown }).raw === "string" &&
		"parsed" in (value as object)
	);
}

export type CompareOp = "eq" | "ne" | "lt" | "gt" | "le" | "ge" | "like";

/** Op arithmétique canonique côté IR — mêmes symboles qu'à la surface. */
export type ArithOp = "+" | "-" | "*" | "/" | "%";

/**
 * Span source SNQL optionnel porté par chaque node du plan. Utilisé pour
 * remonter un `$N` d'erreur Postgres (ou un `LINE N position M` — Phase 3b)
 * jusqu'au token source SNQL exact — l'utilisateur voit son propre code
 * souligné, pas un byte-offset du SQL généré qu'il n'écrit jamais.
 *
 * Optionnel pour ne pas casser les consommateurs qui produisent un
 * plan sans traçabilité (constructions synthétiques, tests). Peuplé par
 * le lowering AST → plan quand un span AST source existe.
 */
export type PlanExpr = (
	| { readonly kind: "literal"; readonly value: SqlValue }
	| { readonly kind: "field"; readonly path: readonly string[] }
	| {
			readonly kind: "compare";
			readonly op: CompareOp;
			readonly left: PlanExpr;
			readonly right: PlanExpr;
	  }
	| { readonly kind: "and"; readonly left: PlanExpr; readonly right: PlanExpr }
	| { readonly kind: "or"; readonly left: PlanExpr; readonly right: PlanExpr }
	| { readonly kind: "not"; readonly operand: PlanExpr }
	// Canonicalisé au lowering : `x = null` / `null = x` / `x != null` → IS [NOT] NULL.
	| {
			readonly kind: "isNull";
			readonly negated: boolean;
			readonly operand: PlanExpr;
	  }
	| {
			readonly kind: "in";
			readonly target: PlanExpr;
			readonly values: readonly PlanExpr[];
	  }
	// Arithmétique scalaire binaire — codegen émet des parens défensives autour
	// pour ne pas dépendre de la précédence native du moteur.
	| {
			readonly kind: "arith";
			readonly op: ArithOp;
			readonly left: PlanExpr;
			readonly right: PlanExpr;
	  }
	// Appel de fonction validé — nom canonique (lowercased), args lowered.
	// Le codegen délègue au renderer du registre pour l'engine cible.
	//
	// flags optionnels pour les aggregates.
	//  - `star` : `count(*)` — args=[]. Invariants documentés au parser/lower.
	//  - `unique` : `count(unique x)` — args.length=1. Réservé aggregates.
	//
	// `sortKeys?` — sort intra-call pour aggregateMulti
	// (`array_agg / string_agg / json_agg`). Codegen PG émet ORDER BY dans
	// la fonction ; Mongo utilise $sortArray en $project ; runtime KV trie
	// avant reduce.
	| {
			readonly kind: "call";
			readonly name: string;
			readonly args: readonly PlanExpr[];
			readonly star?: true;
			readonly unique?: true;
			readonly sortKeys?: readonly PlanSortKey[];
	  }
	// Cast explicite. Distinct de `call` : pas dans le registre de fonctions, pas
	// soumis à assertNoCallInWrite (déterministe + NULL propagate → autorisé en
	// write). Le codegen mappe `target` vers le type engine via PG_CAST_TYPE /
	// MONGO_CAST_TYPE. Span porté = span de l'operand (targeting PG 22P02).
	| {
			readonly kind: "cast";
			readonly target: CastTarget;
			readonly operand: PlanExpr;
	  }
	// Object literal (`{n: 42, k: r.name}`). Retour statique `json`. Codegen PG
	// : `jsonb_build_object($1, $2::TYPE, ...)` avec keys+values bindées.
	// Codegen Mongo : BSON natif via `toExprOperand` récursif. Pas de keyQuoted
	// en IR (info surface pour formatter uniquement).
	| {
			readonly kind: "object";
			readonly entries: readonly PlanObjectEntry[];
	  }
	// Array literal (`[10, 20, 30]`). Retour statique `json`. Codegen PG :
	// `jsonb_build_array($1::TYPE, ...)`. Codegen Mongo : BSON array natif.
	// Utilisable dans une value d'insert via widening PlanRowValue.
	| {
			readonly kind: "array";
			readonly items: readonly PlanExpr[];
	  }
	// `case { c1 -> v1, c2 -> v2, else -> v3 }`. First-match wins.
	// elseValue toujours défini (else obligatoire à la surface). Codegen PG :
	// CASE WHEN. Codegen Mongo : $switch. Runtime KV : evalValue short-circuit
	// avec strict `=== true` sur cond (parité PG 3VL, null/false/0 → else).
	| {
			readonly kind: "case";
			readonly branches: readonly PlanCaseBranch[];
			readonly elseValue: PlanExpr;
	  }
	// window function — `fn(args) over (partition <col> sort <key>)`.
	// Distinct de `call` : sémantique per-row-in-partition-context (row_number,
	// rank, dense_rank + agg-over-window plus tard). Codegen PG émet `FN() OVER
	// (PARTITION BY ... ORDER BY ...)` dans le SELECT. Codegen Mongo insère un
	// `$setWindowFields` AVANT le `$project` avec un alias interne réutilisé.
	// Runtime KV : pre-processing dans compensate (bucket par partition, sort,
	// assign compute par row).
	| {
			readonly kind: "windowCall";
			readonly name: string;
			readonly args: readonly PlanExpr[];
			readonly partitionKeys: readonly (readonly string[])[];
			readonly sortKeys: readonly PlanSortKey[];
	  }
	// sub-query uncorrelated — `(find t pick y)` en position
	// d'expression. Le `plan` est un LogicalPlan récursif (query nested
	// abaissée). Codegen PG : `(SELECT ...)` inline. Autres engines : refusé
	// v1 (capability `subquery` PG-only).
	| {
			readonly kind: "subquery";
			readonly plan: LogicalPlan;
	  }
	// `exists (find...)` — retourne bool ssi subquery renvoie
	// au moins une row. Le `subplan` est TOUJOURS un LogicalPlan (unwrap du
	// PlanExpr.subquery au lower).
	| {
			readonly kind: "exists";
			readonly subplan: LogicalPlan;
	  }
	// `new.<col>` — référence la row proposée d'un upsert.
	// Valide UNIQUEMENT dans le scope `on conflict (…) edit set / where` d'un
	// insert. Le lower transforme `Expr.field {path:["new", col]}` en cette
	// variant seulement à l'intérieur du scope upsert ; ailleurs, `new` reste
	// un ident ordinaire (colonne réelle nommée `new` supportée). Codegen PG
	// émet `EXCLUDED."<column>"`.
	| {
			readonly kind: "upsertNew";
			readonly column: string;
	  }
) & { readonly span?: Span };

/** Entry d'un `PlanExpr.object` — key canonique + value lowered. */
export interface PlanObjectEntry {
	readonly key: string;
	readonly value: PlanExpr;
}

/** Branche d'un `PlanExpr.case` — condition + valeur lowered. */
export interface PlanCaseBranch {
	readonly cond: PlanExpr;
	readonly value: PlanExpr;
}

/**
 * Champ projeté au niveau IR. Symétrique de [[FieldSelection]] côté surface :
 * `expr` prioritaire sur `path`, alias obligatoire dès qu'une expression est
 * en jeu (contrat vérifié au lower).
 */
export interface PlanProjectField {
	readonly path: readonly string[];
	readonly expr?: PlanExpr;
	readonly alias?: string;
}

export interface PlanSortKey {
	readonly path: readonly string[];
	readonly direction: "asc" | "desc";
	/**
	 * Vrai ssi le schema déclare cette clé `nullable: false` (ADR-032). Permet au
	 * codegen Mongo d'émettre un `$sort` plat (index préservé) au lieu du null-rank
	 * de parité 3VL — sans null possible, l'ordre natif Mongo = ordre PG. Absent /
	 * false = nullable, computed, joint, ou schema inconnu → null-rank émis (défaut
	 * sûr = parité garantie).
	 */
	readonly provablyNotNull?: boolean;
}

export type LogicalPlan =
	| {
			readonly op: "scan";
			readonly collection: string;
			readonly alias?: string;
	  }
	| {
			readonly op: "filter";
			readonly input: LogicalPlan;
			readonly predicate: PlanExpr;
	  }
	// DISTINCT via `unique` flag et/ou `distinctOnKeys` explicites.
	// `unique` seul = SELECT DISTINCT sur tous les fields projetés.
	// `distinctOnKeys` non-vide = SELECT DISTINCT ON (keys) — la 1re row de
	// chaque groupe (par keys) conservée, ordre défini par le sort suivant
	// (check prefix-match au lower).
	| {
			readonly op: "project";
			readonly input: LogicalPlan;
			readonly fields: readonly PlanProjectField[];
			readonly unique?: true;
			readonly distinctOnKeys?: readonly (readonly string[])[];
	  }
	| {
			readonly op: "sort";
			readonly input: LogicalPlan;
			readonly keys: readonly PlanSortKey[];
	  }
	| {
			readonly op: "limit";
			readonly input: LogicalPlan;
			readonly count: number;
			readonly offset?: number;
	  }
	// Join. `kind` détermine la sémantique côté codegen :
	//  - `embed` : chaque ligne gauche reçoit un TABLEAU des lignes droites matchées
	// sous le champ `as` (comportement historique, cf. ). Adapté aux
	//    relations one-to-many / many-to-many. Les refs `alias.field` en pick/where
	//    ne sont pas résolvables — utiliser `pick alias` pour l'array complet.
	//  - `join` : LEFT JOIN classique, `alias` = **une** row unique projetée à côté
	//    des colonnes de la source. Refs `alias.field` deviennent des refs SQL
	//    directes. Adapté aux relations many-to-one / one-to-one.
	// Choisi au lower : mot-clé user (`with one`/`with many`) prioritaire, sinon
	// inférence via SchemaModel, sinon fallback `embed`.
	//  - `count` : reverse-nav agrégé (ADR-031 D7) — `alias` = scalaire = count
	//    des lignes droites matchées par ligne gauche. PG : sous-requête corrélée
	//    `(SELECT count(*) …)`. Mongo : `$lookup` + `$size`. Adapté au reverse-nav
	//    `find users pick orders.count`.
	| {
			readonly op: "join";
			readonly input: LogicalPlan;
			readonly collection: string;
			readonly as: string;
			readonly localField: readonly string[];
			readonly foreignField: readonly string[];
			readonly kind: "embed" | "join" | "count";
	  }
	// agrégation scalaire fold — `pick count(*)`, `pick sum(x)`.
	// `groupKeys` toujours undefined en (fold sur toute la collection,
	// 1 row output). (`group by`) le peuplera sans refactor. `fields`
	// contient au moins un PlanProjectField dont `expr` est un call kind='aggregate'
	// (validation au lower). Codegen PG : SELECT-list nue (implicit grouping natif).
	// Codegen Mongo : PAIRE [$group{_id:null,...}, $project{_id:0,...}] via SSA
	// extract. Runtime KV : foldAggregate → 1 row.
	| {
			readonly op: "aggregate";
			readonly input: LogicalPlan;
			readonly fields: readonly PlanProjectField[];
			readonly groupKeys?: readonly (readonly string[])[];
			readonly having?: PlanExpr;
	  };

/** Une affectation de colonne dans un `update` : `column = value`. */
export interface PlanColumnValue {
	readonly column: string;
	readonly value: PlanExpr;
}

/**
 * Cellule d'une row d'insert. **Discriminant** pour widening :
 *  - `scalar` : valeur SqlValue (comportement historique — literal simple).
 *  - `jsonLiteral` : object/array literal composite → PlanExpr rendu au
 *    codegen (`jsonb_build_object` / BSON récursif). Débloque `add {meta:
 *    {tier: "gold"}} into t` sans passer par le workaround `raw` déguisé.
 *
 * SqlValue reste inchangé pour éviter l'invasion transversale (join keys,
 * compareValues KV, isSqlDecimal — tous scalaires).
 */
export type PlanRowValue =
	| { readonly kind: "scalar"; readonly value: SqlValue }
	| { readonly kind: "jsonLiteral"; readonly expr: PlanExpr };

/**
 * Plan de **mutation** (écriture). Contrairement au [[LogicalPlan]] de lecture,
 * ce n'est pas une chaîne d'opérateurs linéaire : chaque mutation porte sa cible,
 * son prédicat, ses valeurs. Exige la capacité `mutate`.
 */
/**
 * action sur conflit d'un upsert lowered.
 *  - `ignore` : `ON CONFLICT (...) DO NOTHING`.
 *  - `update` : `ON CONFLICT (...) DO UPDATE SET c = expr [WHERE p]`. Les
 *    `assignments.value` peuvent contenir des `PlanExpr.upsertNew` (réfs
 *    `EXCLUDED.<col>` côté PG) ; le predicate `where` peut aussi.
 */
export type PlanOnConflictAction =
	| { readonly kind: "ignore" }
	| {
			readonly kind: "update";
			readonly assignments: readonly PlanColumnValue[];
			readonly where?: PlanExpr;
	  };

export interface PlanOnConflict {
	readonly keys: readonly string[];
	readonly action: PlanOnConflictAction;
}

/**
 * join lowered pour un `update t with one X on l=f`. `kind`
 * verrouillé à `"join"` (many = refusé au lower). `as` = alias effectif de
 * la table jointe (soit user-specified, soit égal à `collection` sinon).
 */
export interface PlanUpdateJoin {
	readonly collection: string;
	readonly as: string;
	readonly localField: readonly string[];
	readonly foreignField: readonly string[];
}

export type MutationPlan =
	| {
			readonly op: "insert";
			readonly collection: string;
			readonly columns: readonly string[];
			// Une ligne = un tuple de valeurs aligné sur `columns`. Sprint object-literals :
			// widened en PlanRowValue (scalar | jsonLiteral) pour accepter les composites.
			readonly rows: readonly (readonly PlanRowValue[])[];
			/**
			 * Spans source SNQL, arrays parallèles à `rows` (Phase 3c — traçabilité
			 * pour batch INSERT). Optionnels ; peuvent être présents en partie (ex.
			 * une row synthétique sans span). Résout unique/FK violation → row source.
			 */
			readonly rowSpans?: readonly (Span | undefined)[];
			readonly cellSpans?: readonly (readonly (Span | undefined)[])[];
			// clause upsert. Exige capability `upsert` (PG only v1).
			readonly onConflict?: PlanOnConflict;
			// `pick count` → drop `RETURNING *` côté codegen.
			readonly returnRowCount?: true;
			/**
			 * INSERT SELECT — quand présent, `rows` est vide et
			 * `columns` porte les noms cibles inférés du `pick` de la sub-query
			 * (`pick x as tgt_col` → tgt_col). Le codegen émet `INSERT INTO t
			 * (cols) SELECT … FROM …` en réutilisant renderPlan sur sourcePlan.
			 * Exige capability `insert-select` (PG only v1).
			 */
			readonly sourcePlan?: LogicalPlan;
	  }
	| {
			readonly op: "update";
			readonly collection: string;
			// alias source `update t as a set …`. Utilisé par le
			// codegen pour émettre `UPDATE t AS a SET …` et résoudre `a.col`
			// dans set/where sans FROM-clause fantôme.
			readonly alias?: string;
			// joins de mutation `update t with one X on l=f set …`.
			// PG only (capability `write-join`). `with many` refusé au lower.
			readonly joins?: readonly PlanUpdateJoin[];
			readonly assignments: readonly PlanColumnValue[];
			// Absent = toutes les lignes (write non filtré, assumé).
			readonly predicate?: PlanExpr;
			readonly returnRowCount?: true;
	  }
	| {
			readonly op: "delete";
			readonly collection: string;
			readonly predicate?: PlanExpr;
			readonly returnRowCount?: true;
	  };

/**
 * item de body d'un TransactionPlan — soit une lecture
 * (LogicalPlan wrapped), soit une mutation (MutationPlan wrapped), soit
 * un sous-bloc savepoint récursif.
 */
export type TransactionPlanItem =
	| { readonly kind: "read"; readonly plan: LogicalPlan }
	| { readonly kind: "write"; readonly plan: MutationPlan }
	| {
			readonly kind: "savepoint";
			readonly name: string;
			readonly body: readonly TransactionPlanItem[];
	  };

/**
 * plan d'une transaction. Exige capability `transaction`
 * (PG only v1). Le codegen produit un `SqlTransaction` avec statements
 * pré-rendus, l'engine wrap avec BEGIN [ISOLATION LEVEL X] / COMMIT /
 * ROLLBACK et gère les SAVEPOINT / RELEASE.
 */
export interface TransactionPlan {
	readonly op: "transaction";
	readonly isolation?: import("../parser/ast").IsolationLevel;
	readonly body: readonly TransactionPlanItem[];
}

/**
 * plan d'introspection. Exige capability `introspect`. Le
 * codegen produit un native adapté à l'engine cible (SqlQuery PG via
 * information_schema, MongoIntrospect via listCollections). `target` porte
 * l'ident cible quand pertinent (ex: `describe <target>`).
 */
export interface IntrospectPlan {
	readonly op: "introspect";
	readonly kind: import("../parser/ast").IntrospectKind;
	readonly target?: string;
	/**
	 * stages post-introspection (where/pick/sort/limit) déjà
	 * lowered en ops de compensation. PG les inline dans un SELECT wrapper
	 * `FROM (baseSql) AS t`. Mongo les applique via compensate() côté engine
	 * sur les rows renvoyées par listCollections/sample.
	 */
	readonly postOps?: readonly import("../planner/planner").CompensationOp[];
}

/**
 * plan `raw` — pass-through du payload AST. Le mapper vérifie
 * la compatibilité shape/engine (raw sql sur PG, raw object sur Mongo) et
 * refuse le cross avec un message dédié.
 */
export interface RawPlan {
	readonly op: "raw";
	readonly payload: import("../parser/ast").RawPayload;
}

/**
 * un binding CTE lowered. Chaque nom devient une "collection
 * virtuelle" visible dans le body plan — le codegen PG l'émet en préfixe
 * `WITH <name> AS (<subplan-sql>)` (plain) ou
 * `WITH RECURSIVE <name> AS ((<base>) UNION ALL (<step>))` (recursive).
 * Discriminated union pour survivre au JSON round-trip du store fullscreen.
 */
export type PlanCteBinding =
	| { readonly kind: "plain"; readonly name: string; readonly plan: LogicalPlan }
	| {
			readonly kind: "recursive";
			readonly name: string;
			readonly base: LogicalPlan;
			readonly step: LogicalPlan;
	  };

/**
 * wrapper `let x1 = …; x2 = …; body`. Le body est un plan
 * classique (Logical pour find, Mutation pour add/update/remove) qui a été
 * lowered en considérant les cte names comme des collections légitimes.
 * PG only v1 (capability `cte`) — Mongo refuse au planner.
 */
export interface LetPlan {
	readonly op: "let";
	readonly bindings: readonly PlanCteBinding[];
	readonly body: LogicalPlan | MutationPlan;
}

/**
 * `create table` lowered. Le lower a :
 *  - validé les identifiers (D1 regex `^[A-Za-z_][A-Za-z0-9_]{0,62}$`),
 *  - normalisé le type via `SnqlType` (D6 aliases déjà résolus au parser),
 *  - matérialisé chaque default en `SqlValue` scalaire canonique (literal only),
 *  - vérifié que chaque field du `primaryKey` existe dans `fields`.
 *
 * Le dispatch cross-engine (PG natif / Mongo compensated + alias `_id` D13 /
 * KV compensated via `HSET namespace:_schema`) se fait au planner + codegen ;
 * ici le plan reste engine-agnostique.
 */
/**
 * FK résolue au lower (ADR-031 FK/1). Le lower a validé que la cible existe
 * (collection + colonne), généré le nom de contrainte si absent, et normalisé
 * les règles cascade (défaut `restrict`). Snapshot consommé par le codegen :
 * PG émet `REFERENCES <target>(<col>) ON DELETE ...` inline, Mongo/KV stockent
 * `_snql_refs` + middleware pré-write.
 */
export interface FieldRefPlan {
	readonly name: string;
	/** Colonne portante (le côté « many »). */
	readonly fromColumn: string;
	readonly targetCollection: string;
	readonly targetColumn: string;
	readonly onDelete: import("../schema/model").OnDeleteRule;
	readonly onUpdate: import("../schema/model").OnUpdateRule;
}

export interface CreateTableField {
	readonly name: string;
	readonly type: import("../schema/model").SnqlType;
	readonly nullable: boolean;
	readonly unique: boolean;
	readonly defaultValue?: DdlDefault;
	// Enum info — présent uniquement si `type === "enum"` résolu depuis
	// `schema.enums[]` (ADR-030 Enum/2). Snapshot des members au moment du
	// lower : PG codegen émet `enumTypeName` unquoted, Mongo codegen inline
	// `{enum: enumMembers}` dans le $jsonSchema, KV enrichit le middleware.
	readonly enumTypeName?: string;
	readonly enumMembers?: readonly string[];
	// FK info — présent uniquement si le field a un modifier `ref` (ADR-031).
	// Résolu + validé au lower depuis `schema.collections`.
	readonly ref?: FieldRefPlan;
	readonly span?: Span;
}

export interface CreateTablePlan {
	readonly op: "ddl";
	readonly kind: "create-table";
	readonly target: string;
	readonly ifNotExists: boolean;
	readonly fields: readonly CreateTableField[];
	readonly primaryKey?: readonly string[];
	readonly span?: Span;
}

/**
 * `add column` lowered (ADR-029 DDL/2). Le lower a :
 *  - validé les identifiers (D1 regex `^[A-Za-z_][A-Za-z0-9_]{0,62}$`) sur
 *    target + column name,
 *  - normalisé le type via `SnqlType` (D6 aliases déjà résolus au parser),
 *  - matérialisé le default en `SqlValue` scalaire canonique (literal only).
 *
 * D2 (`add column NOT NULL` sans default = preflight Mongo `countDocuments
 * {$exists:false}` avant `collMod`) et D10 (backfill obligatoire cross-engine)
 * se font au runtime adapter, PAS ici — le plan reste engine-agnostique.
 */
export interface AddColumnPlan {
	readonly op: "ddl";
	readonly kind: "add-column";
	readonly target: string;
	readonly ifNotExists: boolean;
	readonly column: CreateTableField;
	readonly span?: Span;
}

/**
 * `add index` / `add unique index` lowered (ADR-029 DDL/3). Le lower a :
 *  - validé target + fields via IDENT_REGEX D1,
 *  - généré un `name` auto si absent (pattern `idx_<table>_<f1_f2>` ou
 *    `unique_<table>_<f1_f2>`) — permet aussi le drop ultérieur par nom.
 *
 * D11 PG : `CREATE INDEX CONCURRENTLY` par défaut (refus in-tx natif PG). D12
 * KV : compensation via write-middleware SETNX si `unique=true` (adapter
 * runtime KV).
 */
export interface AddIndexPlan {
	readonly op: "ddl";
	readonly kind: "add-index" | "add-unique-index";
	readonly target: string;
	readonly fields: readonly string[];
	readonly name: string;
	readonly ifNotExists: boolean;
	readonly span?: Span;
}

/**
 * `drop index` lowered (ADR-029 DDL/3). Le lower valide target + name via
 * IDENT_REGEX D1. Idempotence D3 name-only via `ifExists`.
 */
export interface DropIndexPlan {
	readonly op: "ddl";
	readonly kind: "drop-index";
	readonly target: string;
	readonly name: string;
	readonly ifExists: boolean;
	readonly span?: Span;
}

/**
 * `drop table` lowered (ADR-029 DDL/4). Le lower valide target via
 * IDENT_REGEX D1. Idempotence D3 name-only via `ifExists`. Destructif —
 * le frontend applique D7 typing UI gate WriteConfirmBar avant Execute.
 */
export interface DropTablePlan {
	readonly op: "ddl";
	readonly kind: "drop-table";
	readonly target: string;
	readonly ifExists: boolean;
	readonly span?: Span;
}

/**
 * `drop column` lowered (ADR-029 DDL/4). Le lower valide target + column
 * via IDENT_REGEX D1. Destructif — D7 typing UI gate. Compensation Mongo :
 * collMod validator (retire property) + updateMany `$unset` batched (miroir
 * D10 backfill). Compensation KV : SCAN + HDEL batched.
 */
export interface DropColumnPlan {
	readonly op: "ddl";
	readonly kind: "drop-column";
	readonly target: string;
	readonly column: string;
	readonly ifExists: boolean;
	readonly span?: Span;
}

/**
 * `create enum` lowered (ADR-030 Enum/1). Le lower a validé D1 ident regex
 * sur `name` + tous les `members`, dédupliqué les members (refus si doublon)
 * et vérifié que la liste est non-empty. Cross-engine : PG `CREATE TYPE AS
 * ENUM(…)` natif, Mongo `_snql_enums` metadata + validator propagé aux
 * $jsonSchema, KV `HSET _snql_enums` + middleware write.
 */
export interface CreateEnumPlan {
	readonly op: "ddl";
	readonly kind: "create-enum";
	readonly name: string;
	readonly members: readonly string[];
	readonly ifNotExists: boolean;
	readonly span?: Span;
}

/**
 * `add enum member` lowered (ADR-030 Enum/3). Append-only safe. Le lower a
 * validé D1 ident regex sur `name` + validé que `member` est un string. La
 * dedup silence si déjà présent est déléguée au runtime (PG `IF NOT EXISTS`
 * natif, Mongo `$addToSet`, KV set). `ifNotExists` implicite au niveau
 * planner — présent explicitement pour tracer l'intention user.
 */
export interface AddEnumMemberPlan {
	readonly op: "ddl";
	readonly kind: "add-enum-member";
	readonly name: string;
	readonly member: string;
	readonly ifNotExists: boolean;
	readonly span?: Span;
}

/**
 * `drop enum` lowered (ADR-030 Enum/3 D8). Destructive — D7 typing gate.
 * RESTRICT par défaut : refus si l'enum est utilisé par ≥1 colonne. CASCADE
 * explicite drop les colonnes utilisatrices (PG natif ; Mongo compense en
 * retirant `bsonType: string, enum: [...]` des validators + laisse les rows
 * intactes — le validator ne rejette plus les valeurs).
 */
export interface DropEnumPlan {
	readonly op: "ddl";
	readonly kind: "drop-enum";
	readonly name: string;
	readonly ifExists: boolean;
	readonly cascade: boolean;
	readonly span?: Span;
}

/**
 * Union des plans DDL. Corpus Tier-2 (create-table/add-column/[add-|drop-]
 * index/drop-table/drop-column) + Enum Tier-3+ (create-enum/add-enum-member/
 * drop-enum).
 */
export type DDLPlan =
	| CreateTablePlan
	| AddColumnPlan
	| AddIndexPlan
	| DropIndexPlan
	| DropTablePlan
	| DropColumnPlan
	| CreateEnumPlan
	| AddEnumMemberPlan
	| DropEnumPlan;

/** Un plan complet : lecture, mutation, transaction, introspect, raw, let/CTE ou DDL Tier-2. */
export type Plan =
	| LogicalPlan
	| MutationPlan
	| TransactionPlan
	| IntrospectPlan
	| RawPlan
	| LetPlan
	| DDLPlan;

export type PlanOp = LogicalPlan["op"];

/** Capacité exigée par chaque opérateur — consommé par le planner. */
export const REQUIRED_CAPABILITY: Readonly<Record<PlanOp, Capability>> = {
	scan: "scan",
	filter: "filter",
	project: "project",
	sort: "sort",
	limit: "paginate",
	join: "join",
	aggregate: "aggregate"
};

export function requiredCapability(plan: LogicalPlan): Capability {
	return REQUIRED_CAPABILITY[plan.op];
}

/** Linéarise la chaîne d'opérateurs, du scan (interne) vers l'extérieur. */
export function linearize(plan: LogicalPlan): LogicalPlan[] {
	const ops: LogicalPlan[] = [];
	let current: LogicalPlan = plan;
	while (current.op !== "scan") {
		ops.push(current);
		current = current.input;
	}
	ops.push(current);
	ops.reverse();
	return ops;
}
