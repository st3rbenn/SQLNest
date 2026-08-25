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
 * (→ , le cœur n'est pas un garde-fou).
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
	| {
			/**
			 * Sprint v3 Mongo : upsert = `add {…} into t on conflict (k) [ignore |
			 * edit set …]`. Une entrée par row du batch — chacune porte son propre
			 * filter (les valeurs des key cols) + $set (si action=edit) +
			 * $setOnInsert (les autres cols de la row). L'adapter émet bulkWrite
			 * pour atomicité serveur-side.
			 */
			readonly op: "upsert";
			readonly operations: readonly {
				readonly filter: Record<string, unknown>;
				readonly set?: Record<string, unknown>;
				readonly setOnInsert: Record<string, unknown>;
			}[];
	  }
	| {
			/**
			 * write-join Mongo via aggregate + `$merge`. Le
			 * codegen produit un pipeline `[$match?, $lookup, $unwind, $set,
			 * $unset(__j0), $merge{into: <same>, whenMatched: 'merge',
			 * whenNotMatched: 'discard'}]`. L'adapter exécute via
			 * `db.collection.aggregate(pipeline).toArray()` — le `$merge` est un
			 * stage terminal qui écrit comme side-effect. Atomicité par-doc via
			 * `whenMatched: 'merge'` (Mongo 4.2+). rowCount non-reporté (limitation
			 * `$merge` : la cursor result est vide) — le caller reçoit rowCount=null.
			 * perf-warning (join key non-indexée) délivré en.
			 */
			readonly op: "update-agg-merge";
			readonly pipeline: readonly MongoStage[];
	  }
	| {
			/**
			 * insert-select Mongo via aggregate + `$merge` dans
			 * une collection différente. Le codegen émet `[...source pipeline...,
			 * $merge{into: target, whenMatched: 'fail', whenNotMatched: 'insert'}]`.
			 * L'adapter exécute via `db.<sourceCollection>.aggregate(pipeline)`.
			 * session tx obligatoire (Mongo 5.0+ RS) — l'adapter refuse hors
			 * session avec `planner_mongo_insert_select_requires_txn`. `collection`
			 * porte le TARGET, `sourceCollection` le root scan à agréger.
			 */
			readonly op: "insert-select-agg-merge";
			readonly sourceCollection: string;
			readonly pipeline: readonly MongoStage[];
	  }
);

/**
 * bloc transaction PG. `statements` = liste plate (pas de
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
 * native shape pour une commande d'introspection Mongo. PG
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
 * Sprint TxMongo : bloc transaction Mongo. Séquence linéaire de steps
 * pré-rendus — pas de savepoints (Mongo ne les supporte pas ; refusés au
 * codegen). L'isolation SNQL est mappée par l'adapter en `readConcern` +
 * `writeConcern` sur la session (`serializable` → snapshot+majority,
 * `read_committed` → majority, `read_uncommitted` → refusé au codegen).
 */
export type MongoTransactionStep =
	| { readonly kind: "query"; readonly query: MongoQuery }
	| { readonly kind: "write"; readonly write: MongoWriteQuery }
	// savepoint préservé comme step dédié, non aplati.
	// L'adapter exécute chaque body step avec snapshot pre-write + compensation
	// runtime si erreur (inverse ops dans même session tx).
	| {
			readonly kind: "savepoint";
			readonly name: string;
			readonly body: readonly MongoTransactionStep[];
	  };

export interface MongoTransaction {
	readonly engine: string;
	readonly kind: "mongo-transaction";
	readonly isolation?: IsolationLevel;
	readonly steps: readonly MongoTransactionStep[];
}

/**
 * DDL Tier-2 sur Mongo (ADR-029). Compensated : pas de `CREATE TABLE`
 * natif, on émet un plan structuré que l'adapter Mongo exécute via
 * `db.createCollection` + `createIndex`. V1 (DDL/1) couvre `create-collection`
 * uniquement.
 *
 * D13 primary key :
 *  - `primaryKeyAlias='id'` = single-field id-like UUID aliasé vers `_id`
 *    (le validator omet `id` — c'est _id BSON).
 *  - `indexes[]` porte les compound PK + les uniques field-level.
 *
 * D3 idempotence (`ifNotExists=true`) : l'adapter catch NamespaceExists
 * code 48 sur `createCollection` et traite comme succès.
 */
export interface MongoIndexSpec {
	readonly keys: Readonly<Record<string, 1>>;
	readonly options: {
		readonly unique?: boolean;
		readonly name?: string;
	};
}

export interface MongoDDLCreateCollectionQuery {
	readonly engine: string;
	readonly kind: "mongo-ddl";
	readonly operation: "create-collection";
	readonly collection: string;
	readonly ifNotExists: boolean;
	readonly validator?: Record<string, unknown>;
	readonly indexes?: readonly MongoIndexSpec[];
	/**
	 * Si présent, nom du field SNQL aliasé vers `_id` BSON (D13 single-field
	 * id-like UUID). L'adapter renomme au read/write pour préserver le nom
	 * SNQL côté user.
	 */
	readonly primaryKeyAlias?: string;
}

/**
 * DDL/2 add column sur Mongo (ADR-029). Compensated via `collMod` +
 * `$jsonSchema` validator étendu + backfill runtime `updateMany` batched
 * (D10 obligatoire cross-engine).
 *
 * L'adapter runtime doit :
 *  1. **D2 preflight** : si `preflightNotNull=true` (add column NOT NULL sans
 *     default), `countDocuments({[column.name]: {$exists:false}})` — si `> 0`
 *     refus runtime typé `runtime_mongo_add_column_not_null_would_orphan_N_docs`
 *     avec message copiable pointant vers `update ... set = ... where ... is null`
 *     puis relance.
 *  2. Applique `collMod` avec le validator étendu (`properties.<col>` +
 *     required éventuel).
 *  3. **D10 backfill** : si `backfill=true` (defaultValue défini),
 *     `updateMany({[column.name]: {$exists:false}}, {$set: {[column.name]:
 *     defaultValue}})` batched (défaut 10k docs/batch + 50ms throttle,
 *     `mongo.ddl.backfill_batch_size` / `mongo.ddl.backfill_max_rows` config).
 *  4. Si `index` présent, `createIndex(keys, options)` — DDL/3 pattern D12.
 */
export interface MongoDDLAddColumnQuery {
	readonly engine: string;
	readonly kind: "mongo-ddl";
	readonly operation: "add-column";
	readonly collection: string;
	readonly ifNotExists: boolean;
	readonly column: {
		readonly name: string;
		/** null = SnqlType `unknown` — pas de contrainte bsonType côté validator. */
		readonly bsonType: string | null;
		/** `required` du validator étendu (contrat cross-engine : NOT NULL). */
		readonly required: boolean;
		readonly defaultValue?: unknown;
	};
	/** true si `defaultValue !== undefined` → D10 backfill obligatoire. */
	readonly backfill: boolean;
	/**
	 * true si `column.required && !backfill` → D2 preflight obligatoire.
	 * L'adapter count `$exists:false` avant `collMod`, refus si > 0.
	 */
	readonly preflightNotNull: boolean;
	/** Index unique secondaire optionnel (add column ... unique). */
	readonly index?: MongoIndexSpec;
}

/**
 * DDL/3 add index sur Mongo (ADR-029). Compensated via `createIndex(keys,
 * options)` natif. L'adapter runtime :
 *  1. `db.<collection>.createIndex(keys, options)` — idempotent nativement.
 *  2. D3 idempotence : catch `IndexOptionsConflict` (code 85) ou
 *     `IndexKeySpecsConflict` (code 86) si `ifNotExists=true`, sinon re-throw.
 */
export interface MongoDDLAddIndexQuery {
	readonly engine: string;
	readonly kind: "mongo-ddl";
	readonly operation: "add-index";
	readonly collection: string;
	readonly ifNotExists: boolean;
	readonly index: MongoIndexSpec;
}

/**
 * DDL/3 drop index sur Mongo. `dropIndex(name)` natif. D3 idempotence :
 * catch `IndexNotFound` (code 27) si `ifExists=true`.
 */
export interface MongoDDLDropIndexQuery {
	readonly engine: string;
	readonly kind: "mongo-ddl";
	readonly operation: "drop-index";
	readonly collection: string;
	readonly ifExists: boolean;
	readonly name: string;
}

export type MongoDDLQuery =
	| MongoDDLCreateCollectionQuery
	| MongoDDLAddColumnQuery
	| MongoDDLAddIndexQuery
	| MongoDDLDropIndexQuery;

/**
 * DDL Tier-2 sur KV (ADR-029). Entièrement compensé — KV est schema-less,
 * la « création de table » est du metadata stocké sous `namespace:_schema:{table}`.
 * L'adapter KV runtime consomme ce shape et exécute :
 *  1. `HSET namespace:_schema:{table} <field> <encoded-descriptor>` par field.
 *  2. `HSET namespace:_schema:{table} __primary_key <json>` si `primaryKey`.
 *  3. Enregistre les uniques `uniqueFields` dans le middleware pré-write SETNX
 *     (D12 — arrive vraiment à DDL/3 `add unique index` ; ici on transporte
 *     l'info, pas d'enforcement encore).
 * D3 : `ifNotExists=true` → l'adapter check l'existence du hash `_schema` et
 * no-op si présent.
 *
 * D13 : jamais de refus PK. `primaryKey` (single ou compound) est stocké tel
 * quel dans le metadata — l'adapter s'en sert pour construire une clé unique
 * `namespace:{table}:pk:<val1>:<val2>` au write, via middleware.
 */
export interface KvFieldDescriptor {
	readonly name: string;
	readonly type: string;
	readonly nullable: boolean;
	readonly unique: boolean;
	readonly defaultValue?: unknown;
}

export interface KvDDLCreateTableQuery {
	readonly engine: string;
	readonly kind: "kv-ddl";
	readonly operation: "create-table";
	readonly collection: string;
	readonly ifNotExists: boolean;
	readonly fields: readonly KvFieldDescriptor[];
	readonly primaryKey?: readonly string[];
	readonly uniqueFields?: readonly string[];
}

/**
 * DDL/2 add column sur KV (ADR-029). L'adapter runtime KV consomme et
 * exécute :
 *  1. **D2 preflight** : si `preflightNotNull=true` (NOT NULL sans default),
 *     `SCAN namespace:{collection}:*` + count des rows sans le field — refus
 *     runtime typé si > 0 avec message pointing vers update-first.
 *  2. `HSET namespace:_schema:{collection} <col.name> <encoded-descriptor>` —
 *     ajoute le field au schema metadata.
 *  3. **D10 backfill** : si `backfill=true` (defaultValue défini), `SCAN` +
 *     `HSET` batched — chaque row existante reçoit `HSET row col default`.
 *     Jamais refus (PA/1-8).
 *  4. Si `column.unique`, l'adapter enregistre le field dans le middleware
 *     pré-write SETNX (D12) — arrivera vraiment à DDL/3.
 */
export interface KvDDLAddColumnQuery {
	readonly engine: string;
	readonly kind: "kv-ddl";
	readonly operation: "add-column";
	readonly collection: string;
	readonly ifNotExists: boolean;
	readonly column: KvFieldDescriptor;
	readonly backfill: boolean;
	readonly preflightNotNull: boolean;
}

/**
 * DDL/3 add index sur KV (ADR-029 D12). Non-unique = no-op déclaré au planner
 * (queries retombent en scan compensé, KV n'a pas d'API index natif). Unique
 * = compensation via write-middleware pré-write SETNX : le shape porte les
 * fields + name pour que l'adapter enregistre le middleware qui rejette au
 * write si `SETNX namespace:_unique:<field>:<val>` échoue (violation typée
 * `runtime_kv_unique_violation`).
 *
 * V1 : shape shipped + tests unit only ; wiring adapter runtime KV reste V-next
 * (`packages/engine/src/kv/…` inexistant — adapter Redis-protocol pas encore
 * branché).
 */
export interface KvDDLAddIndexQuery {
	readonly engine: string;
	readonly kind: "kv-ddl";
	readonly operation: "add-index";
	readonly collection: string;
	readonly ifNotExists: boolean;
	readonly name: string;
	readonly fields: readonly string[];
	readonly unique: boolean;
	/**
	 * Doctrine D12 : mode d'enforcement de l'unique côté KV. `"middleware-setnx"`
	 * = adapter middleware pre-write SETNX ; `"none"` = index non-unique (no-op
	 * planner, queries scan). Sérialisé dans le shape pour l'adapter et pour
	 * l'explain UI (surface honnête).
	 */
	readonly uniqueEnforcement: "middleware-setnx" | "none";
}

/**
 * DDL/3 drop index sur KV. Compensation : retire le middleware SETNX enregistré
 * si unique, et retire le field du `_index` metadata. Idempotence via
 * `ifExists`. V1 shape shipped, wiring V-next.
 */
export interface KvDDLDropIndexQuery {
	readonly engine: string;
	readonly kind: "kv-ddl";
	readonly operation: "drop-index";
	readonly collection: string;
	readonly ifExists: boolean;
	readonly name: string;
}

export type KvDDLQuery =
	| KvDDLCreateTableQuery
	| KvDDLAddColumnQuery
	| KvDDLAddIndexQuery
	| KvDDLDropIndexQuery;

/**
 * native shape pour un `raw {...}` Mongo — command native
 * exécutée via db.runCommand(). Le document est déjà évalué en clé/valeur
 * scalaires par le codegen (Expr.object → Record<string, unknown>).
 */
export interface MongoRawQuery {
	readonly engine: string;
	readonly kind: "mongo-raw";
	readonly command: Record<string, unknown>;
}

/**
 * native shape pour un kind d'introspection SQLNest (table système, pas la DB
 * user). Aujourd'hui : `list schema_events` → audit trail `canvas_checksum_event`.
 * Cross-engine : `engine` porte l'engine de la connection user pour trace, mais
 * l'exécution passe par le backend SQLNest en interne (pas le tunnel proxy).
 *
 * Le backend `POST /db-connections/:id/query` détecte
 * `plan.type === 'sqlnest-introspect'` et court-circuite vers le builder interne
 * correspondant (ex : `getCanvasChecksumHistory` pour `schema-events`).
 *
 * `postOps` porte les stages `where/pick/sort/limit` du pipeline SNQL, appliqués
 * en matérialisation client-side sur les rows retournées par le builder — le
 * pushdown vrai (traduire `where seen_at > X` en cursor) reste v-next.
 */
export interface SqlnestIntrospectQuery {
	readonly engine: string;
	readonly kind: "sqlnest-introspect";
	readonly target: "schema-events";
	readonly postOps?: readonly import("../planner/planner").CompensationOp[];
}

/**
 * options passées aux méthodes du Mapper qui ont besoin du
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
	| MongoTransaction
	| MongoIntrospectQuery
	| MongoRawQuery
	| MongoDDLQuery
	| KvDDLQuery
	| SqlnestIntrospectQuery;

/** Contrat de codegen par moteur : plan → requête native. Pur, sans I/O. */
export interface Mapper {
	readonly engine: string;
	/** Lecture : Logical Plan → requête native. */
	map(plan: LogicalPlan): NativeQuery;
	/** Écriture : Mutation Plan → requête native. */
	mapMutation(plan: MutationPlan): NativeQuery;
	/**
	 * transaction PG natif; Mongo via RS.
	 * Absent = engine sans support.
	 */
	mapTransaction?(plan: TransactionPlan): SqlTransaction | MongoTransaction;
	/** introspection (list/describe/etc.). PG et Mongo v1. */
	mapIntrospect?(plan: IntrospectPlan, ctx?: MapperContext): NativeQuery;
	/** escape hatch raw (SQL brut / Mongo command). */
	mapRaw?(plan: import("../ir/plan").RawPlan): NativeQuery;
	/** CTE `let x = ...; body`. PG only v1. */
	mapLet?(plan: import("../ir/plan").LetPlan): NativeQuery;
	/**
	 * DDL Tier-2 (ADR-029) — `create table` v1, extends aux autres kinds à
	 * DDL/2..DDL/4. PG natif via SQL, Mongo compensated via `createCollection`
	 * + `$jsonSchema`, KV compensated via `HSET namespace:_schema` metadata.
	 */
	mapDDL?(plan: import("../ir/plan").DDLPlan, ctx?: MapperContext): NativeQuery;
}
