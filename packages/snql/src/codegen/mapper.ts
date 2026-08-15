import type {
	IntrospectPlan,
	LogicalPlan,
	MutationPlan,
	TransactionPlan
} from "../ir/plan";
import type { IsolationLevel } from "../parser/ast";

/** Une étape de pipeline d'agrégation MongoDB (ex. `{ $match: … }`). */
export type MongoStage = Record<string, unknown>;

/**
 * Span source SNQL sérialisé en compact `[start, length]` — les positions
 * `line`/`column` sont dérivables côté frontend depuis la source SNQL que
 * l'utilisateur a en main. Économie ~67% vs le triplet `{offset,line,column}`.
 */
export type SerializedSpan = readonly [start: number, length: number];

/** Requête SQL : texte + paramètres bindés ($1, $2…). */
export interface SqlQuery {
	readonly engine: string;
	readonly kind: "sql";
	readonly text: string;
	readonly params: readonly unknown[];
	/**
	 * Aligné positionnellement sur `params[i]`. `undefined` en position `i`
	 * signifie qu'aucun span source SNQL n'a pu être rattaché au bind (ex.
	 * un `LIMIT`/`OFFSET` porté par un `number` nu dans le plan, sans span).
	 *
	 * Objectif : résoudre un `could not determine data type of parameter $N`
	 * remonté par Postgres jusqu'au littéral source SNQL exact, pour souligner
	 * dans l'éditeur au bon token — pas au byte-offset du SQL généré.
	 */
	readonly paramSpans?: readonly (SerializedSpan | undefined)[];
	/**
	 * Aligné sur les rows d'un INSERT (Phase 3c). Permet de cibler la row
	 * source d'un `add [{...}, {...}]` fautif sur violation unique/FK. Absent
	 * pour les SELECT/UPDATE/DELETE (pas de notion de row source).
	 */
	readonly rowSpans?: readonly (SerializedSpan | undefined)[];
	/**
	 * Map des spans par nom d'ident (Phase 3b-lite). Peuplé par le caller
	 * avant `connection.execute` — permet de résoudre les pg-errors qui
	 * réfèrent un ident par nom (`column "X" does not exist`) vers ses
	 * occurrences source SNQL sans refactor du codegen.
	 */
	readonly identSpans?: Readonly<Record<string, readonly SerializedSpan[]>>;
}

/** Requête MongoDB : collection + pipeline d'agrégation (valeurs inline, BSON — pas d'injection). */
export interface MongoQuery {
	readonly engine: string;
	readonly kind: "mongo";
	readonly collection: string;
	readonly pipeline: readonly MongoStage[];
}

/**
 * Écriture MongoDB. Une mutation n'est **pas** une agrégation : elle se traduit
 * en commande du driver (`insertMany`/`updateMany`/`deleteMany`), d'où un `kind`
 * distinct de la lecture. Valeurs inline en BSON (données, pas de chaîne) → pas
 * de surface d'injection.
 *
 * `filter` vide (`{}`) = toutes les lignes : un write non filtré est assumé
 * (→ ADR-012, le cœur n'est pas un garde-fou).
 */
export type MongoWriteQuery = {
	readonly engine: string;
	readonly kind: "mongo-write";
	readonly collection: string;
} & (
	| {
			readonly op: "insert";
			readonly documents: readonly Record<string, unknown>[];
	  }
	| {
			readonly op: "update";
			readonly filter: Record<string, unknown>;
			/**
			 * Document de mise à jour (`{ $set: … }`) pour des valeurs littérales, ou
			 * **pipeline** (`[{ $set: … }]`, Mongo 4.2+) dès qu'une affectation
			 * référence un autre champ — seule forme qui l'autorise.
			 */
			readonly update: Record<string, unknown> | readonly MongoStage[];
	  }
	| {
			readonly op: "delete";
			readonly filter: Record<string, unknown>;
	  }
);

/**
 * Sprint T2/15 : bloc transaction PG. `statements` = liste plate (pas de
 * nesting) de statements pré-rendus + directives structurelles pour les
 * savepoints. L'engine émet un `BEGIN` + boucle sur les directives puis
 * `COMMIT` (ou `ROLLBACK` sur erreur). Params sont par statement (chaque
 * SqlQuery garde son propre paramètre count `$1..$N`).
 */
export type SqlTransactionStep =
	| { readonly kind: "statement"; readonly query: SqlQuery }
	| { readonly kind: "savepoint-begin"; readonly name: string }
	| { readonly kind: "savepoint-release"; readonly name: string };

export interface SqlTransaction {
	readonly engine: string;
	readonly kind: "transaction";
	readonly isolation?: IsolationLevel;
	readonly steps: readonly SqlTransactionStep[];
}

/**
 * Sprint T3/1 : native shape pour une commande d'introspection Mongo. PG
 * produit une SqlQuery normale (via information_schema, avec le namespace
 * bindé). Mongo utilise une commande dédiée (`listCollections`) qui n'est
 * pas exprimable en pipeline aggregation.
 */
export interface MongoIntrospectQuery {
	readonly engine: string;
	readonly kind: "mongo-introspect";
	readonly plan: IntrospectPlan;
}

/**
 * Sprint T3/4 : native shape pour un `raw {...}` Mongo — command native
 * exécutée via db.runCommand(). Le document est déjà évalué en clé/valeur
 * scalaires par le codegen (Expr.object → Record<string, unknown>).
 */
export interface MongoRawQuery {
	readonly engine: string;
	readonly kind: "mongo-raw";
	readonly command: Record<string, unknown>;
}

/**
 * Sprint T3/1 : options passées aux méthodes du Mapper qui ont besoin du
 * contexte runtime. Aujourd'hui : namespace (PG schema / Mongo DB name)
 * pour l'introspection. Extensible pour d'autres options futures sans
 * casser la signature.
 */
export interface MapperContext {
	readonly namespace?: string;
}

/** Requête native produite pour un moteur donné. */
export type NativeQuery =
	| SqlQuery
	| MongoQuery
	| MongoWriteQuery
	| SqlTransaction
	| MongoIntrospectQuery
	| MongoRawQuery;

/** Contrat de codegen par moteur : plan → requête native. Pur, sans I/O. */
export interface Mapper {
	readonly engine: string;
	/** Lecture : Logical Plan → requête native. */
	map(plan: LogicalPlan): NativeQuery;
	/** Écriture : Mutation Plan → requête native. */
	mapMutation(plan: MutationPlan): NativeQuery;
	/** Sprint T2/15 : transaction PG-only. Absent = engine sans support. */
	mapTransaction?(plan: TransactionPlan): SqlTransaction;
	/** Sprint T3/1 : introspection (list/describe/etc.). PG et Mongo v1. */
	mapIntrospect?(plan: IntrospectPlan, ctx?: MapperContext): NativeQuery;
	/** Sprint T3/4 : escape hatch raw (SQL brut / Mongo command). */
	mapRaw?(plan: import("../ir/plan").RawPlan): NativeQuery;
	/** Sprint T3/6 : CTE `let x = ...; body`. PG only v1. */
	mapLet?(plan: import("../ir/plan").LetPlan): NativeQuery;
}
