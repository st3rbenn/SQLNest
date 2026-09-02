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
	/**
	 * Colonnes du résultat dont la valeur est une STRING JSON à parser côté
	 * adapter (chantier MSSQL M/3) : T-SQL n'a pas de type json — les embeds
	 * `FOR JSON PATH` et objets de row jointe sortent en nvarchar. PG n'en a
	 * pas besoin (json/jsonb parsés par le driver). Absent = rien à parser.
	 */
	readonly jsonColumns?: readonly string[];
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

/**
 * FK déclarée à stocker dans la collection metadata `_snql_refs` (ADR-031
 * FK/1). L'adapter runtime `insertOne({_id: name, from, fromColumn, to,
 * toColumn, onDelete, onUpdate})`. **FK/1a = stockage déclaration seulement** —
 * l'enforcement (write-precheck + cascade transactionnelle) arrive en FK/1b
 * (asymétrie transitoire assumée : PG applique nativement, Mongo enregistre
 * mais n'enforce pas encore).
 */
export interface MongoRefSpec {
	readonly name: string;
	readonly fromCollection: string;
	readonly fromColumn: string;
	readonly toCollection: string;
	readonly toColumn: string;
	readonly onDelete: string;
	readonly onUpdate: string;
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
	/** FK déclarées sur les colonnes (ADR-031 FK/1a) — stockées `_snql_refs`. */
	readonly refs?: readonly MongoRefSpec[];
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
		/**
		 * Snapshot des members enum (ADR-030 Enum/2). Présent si le field est
		 * typé par un enum nommé. L'adapter injecte `enum: [...]` dans le
		 * validator étendu de la property.
		 */
		readonly enum?: readonly string[];
		/** FK déclarée sur la colonne (ADR-031 FK/1a) — stockée `_snql_refs`. */
		readonly ref?: MongoRefSpec;
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

/**
 * DDL/4 drop collection (SNQL `drop table`) sur Mongo. `db.<collection>.drop()`
 * natif — retour bool (true si dropped, false si n'existait pas). L'adapter
 * runtime catch `NamespaceNotFound` (code 26) si `ifExists=true`.
 */
export interface MongoDDLDropCollectionQuery {
	readonly engine: string;
	readonly kind: "mongo-ddl";
	readonly operation: "drop-collection";
	readonly collection: string;
	readonly ifExists: boolean;
}

/**
 * DDL/4 drop column sur Mongo. Compensation runtime : (1) collMod validator
 * retire la property (+ retire de `required` si présent), (2) `updateMany({},
 * {$unset: {col: ""}})` batched pattern miroir D10 backfill pour purger la
 * valeur dans les docs existants. `ifExists=true` skip si la property n'est
 * pas dans le validator (name-only D3).
 */
export interface MongoDDLDropColumnQuery {
	readonly engine: string;
	readonly kind: "mongo-ddl";
	readonly operation: "drop-column";
	readonly collection: string;
	readonly column: string;
	readonly ifExists: boolean;
}

/**
 * Enum/1 create-enum sur Mongo. Compensation runtime : `insertOne` dans
 * collection metadata `_snql_enums` avec `{_id: name, members}` — idempotent
 * par `_id`. Si `ifNotExists=true`, l'adapter catch DuplicateKey (11000) et
 * silence. Le validator `enum: [...]` sera propagé aux $jsonSchema des
 * tables utilisatrices via Enum/2 (resolve `type: role_type` dans body
 * create-table + adaptation validator).
 */
export interface MongoDDLCreateEnumQuery {
	readonly engine: string;
	readonly kind: "mongo-ddl";
	readonly operation: "create-enum";
	readonly name: string;
	readonly members: readonly string[];
	readonly ifNotExists: boolean;
}

/**
 * Enum/3 add-enum-member sur Mongo. Compensation runtime en 2 étapes :
 *  1. `_snql_enums.updateOne({_id: name}, {$addToSet: {members: value}})` —
 *     dedup naturel par `$addToSet` (idempotent silence si déjà présent, D3
 *     pattern).
 *  2. Pour chaque collection utilisatrice (lister via `listCollections` avec
 *     validator `$jsonSchema.properties.<col>.enum = [members-before]`),
 *     appliquer `collMod` batché avec le nouveau tableau `enum: [...members,
 *     value]`. L'adapter fait le scan + apply.
 *
 * Si `ifNotExists=true` et l'enum est inconnu, l'adapter silence (aligne
 * `IF NOT EXISTS` PG). Si absent et pas de modifier, refuse au runtime.
 */
export interface MongoDDLAddEnumMemberQuery {
	readonly engine: string;
	readonly kind: "mongo-ddl";
	readonly operation: "add-enum-member";
	readonly name: string;
	readonly member: string;
	readonly ifNotExists: boolean;
}

/**
 * Enum/3 drop-enum sur Mongo. Compensation runtime en 2 étapes :
 *  1. `_snql_enums.deleteOne({_id: name})` (si `ifExists=true` : silence si
 *     absent ; sinon refus typé).
 *  2. Rollback des validators : pour chaque collection utilisatrice, `collMod`
 *     batché qui retire `bsonType: "string", enum: [...]` sur la propriété
 *     concernée (laisse le validator existant sur les autres props intact).
 *     Les rows existantes gardent leur valeur — sans validator, la contrainte
 *     n'est plus enforcée mais rien n'est perdu.
 *
 * `cascade` = false (RESTRICT) : refus runtime si l'enum est utilisé par ≥1
 * collection (miroir PG `2BP01 dependent objects`). `cascade` = true :
 * applique le rollback sans check préalable.
 */
export interface MongoDDLDropEnumQuery {
	readonly engine: string;
	readonly kind: "mongo-ddl";
	readonly operation: "drop-enum";
	readonly name: string;
	readonly ifExists: boolean;
	readonly cascade: boolean;
}

/**
 * FK/3 drop-ref sur Mongo (ADR-031). Compensation runtime :
 * `_snql_refs.deleteOne({_id: name})` — `_id` = nom de contrainte (clé
 * d'upsert de la déclaration FK/1a). `deletedCount === 0` : silence si
 * `ifExists=true`, sinon refus typé « ref inconnue ». L'enforcement runtime
 * s'arrête de lui-même : le write path recharge `_snql_refs` à chaque write
 * (`#loadRefs`), aucun cache à invalider. `collection` = table porteuse
 * (fromCollection) — transportée pour le message d'erreur et la cohérence
 * du contrat, le delete est par `_id`.
 */
export interface MongoDDLDropRefQuery {
	readonly engine: string;
	readonly kind: "mongo-ddl";
	readonly operation: "drop-ref";
	readonly collection: string;
	readonly name: string;
	readonly ifExists: boolean;
}

export type MongoDDLQuery =
	| MongoDDLCreateCollectionQuery
	| MongoDDLAddColumnQuery
	| MongoDDLAddIndexQuery
	| MongoDDLDropIndexQuery
	| MongoDDLDropCollectionQuery
	| MongoDDLDropColumnQuery
	| MongoDDLCreateEnumQuery
	| MongoDDLAddEnumMemberQuery
	| MongoDDLDropEnumQuery
	| MongoDDLDropRefQuery;

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
	/**
	 * Snapshot enum members (ADR-030 Enum/2). Présent si `type === "enum"`.
	 * Middleware write refuse valeur hors set (V-next avec adapter Redis).
	 * `enumTypeName` référencable (introspection lookup `_snql_enums`).
	 */
	readonly enumTypeName?: string;
	readonly enum?: readonly string[];
	/**
	 * FK déclarée (ADR-031 FK/1a). Snapshot du référent + règles cascade,
	 * stocké dans `_snql_refs` (shape V1 ; enforcement middleware = FK/1b avec
	 * l'adapter Redis).
	 */
	readonly ref?: {
		readonly name: string;
		readonly toCollection: string;
		readonly toColumn: string;
		readonly onDelete: string;
		readonly onUpdate: string;
	};
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

/**
 * DDL/4 drop table sur KV (ADR-029). Compensation runtime : SCAN
 * `namespace:{collection}:*` + DEL par batch pour purger toutes les rows, +
 * DEL `namespace:_schema:{collection}` metadata + DEL `namespace:_unique:*`
 * (middleware indexes). L'adapter runtime KV consomme le shape ; wiring
 * runtime V-next Redis.
 */
export interface KvDDLDropTableQuery {
	readonly engine: string;
	readonly kind: "kv-ddl";
	readonly operation: "drop-table";
	readonly collection: string;
	readonly ifExists: boolean;
}

/**
 * DDL/4 drop column sur KV. Compensation : SCAN + HDEL par row batched
 * (miroir D10 backfill) + HDEL `namespace:_schema:{collection}` col metadata.
 * Idempotence D3 name-only via `ifExists`.
 */
export interface KvDDLDropColumnQuery {
	readonly engine: string;
	readonly kind: "kv-ddl";
	readonly operation: "drop-column";
	readonly collection: string;
	readonly column: string;
	readonly ifExists: boolean;
}

/**
 * Enum/1 create-enum sur KV. Compensation runtime : `HSET _snql_enums <name>
 * <json members>`. Idempotent par HSET (écrase la valeur si présente, ou pose
 * la 1re fois). `ifNotExists=true` check `HEXISTS _snql_enums <name>` avant
 * pour silence. Middleware write refuse valeur hors set aux tables
 * utilisatrices (Enum/2).
 */
export interface KvDDLCreateEnumQuery {
	readonly engine: string;
	readonly kind: "kv-ddl";
	readonly operation: "create-enum";
	readonly name: string;
	readonly members: readonly string[];
	readonly ifNotExists: boolean;
}

/**
 * Enum/3 add-enum-member sur KV. Compensation runtime : lit
 * `HGET _snql_enums <name>`, ajoute `value` au tableau JSON si absent
 * (dedup naturel), `HSET _snql_enums <name> <json>`. Idempotent silence si
 * déjà présent (D3 pattern). Rien à backfill — les valeurs existantes ne
 * violent pas le nouveau set.
 */
export interface KvDDLAddEnumMemberQuery {
	readonly engine: string;
	readonly kind: "kv-ddl";
	readonly operation: "add-enum-member";
	readonly name: string;
	readonly member: string;
	readonly ifNotExists: boolean;
}

/**
 * Enum/3 drop-enum sur KV. Compensation runtime : `HDEL _snql_enums <name>` +
 * rollback middleware (retire le refus enum sur les tables utilisatrices).
 * RESTRICT (cascade=false) refuse si ≥1 table utilise l'enum ; CASCADE
 * applique le rollback sans check. `ifExists=true` silence si absent.
 */
export interface KvDDLDropEnumQuery {
	readonly engine: string;
	readonly kind: "kv-ddl";
	readonly operation: "drop-enum";
	readonly name: string;
	readonly ifExists: boolean;
	readonly cascade: boolean;
}

/**
 * FK/3 drop-ref sur KV (ADR-031). Compensation runtime : retire le snapshot
 * `ref` du descriptor de colonne dans `namespace:_schema:{collection}` — le
 * middleware pré-write cesse d'enforcer la ref. Shape V1, wiring runtime
 * V-next (miroir statut DDL Tier-2 KV).
 */
export interface KvDDLDropRefQuery {
	readonly engine: string;
	readonly kind: "kv-ddl";
	readonly operation: "drop-ref";
	readonly collection: string;
	readonly ifExists: boolean;
	readonly name: string;
}

export type KvDDLQuery =
	| KvDDLCreateTableQuery
	| KvDDLAddColumnQuery
	| KvDDLAddIndexQuery
	| KvDDLDropIndexQuery
	| KvDDLDropTableQuery
	| KvDDLDropColumnQuery
	| KvDDLCreateEnumQuery
	| KvDDLAddEnumMemberQuery
	| KvDDLDropEnumQuery
	| KvDDLDropRefQuery;

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
