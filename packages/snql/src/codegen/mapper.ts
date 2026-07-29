import type { LogicalPlan, MutationPlan } from "../ir/plan";

/** Une étape de pipeline d'agrégation MongoDB (ex. `{ $match: … }`). */
export type MongoStage = Record<string, unknown>;

/** Requête SQL : texte + paramètres bindés ($1, $2…). */
export interface SqlQuery {
	readonly engine: string;
	readonly kind: "sql";
	readonly text: string;
	readonly params: readonly unknown[];
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

/** Requête native produite pour un moteur donné. */
export type NativeQuery = SqlQuery | MongoQuery | MongoWriteQuery;

/** Contrat de codegen par moteur : plan → requête native. Pur, sans I/O. */
export interface Mapper {
	readonly engine: string;
	/** Lecture : Logical Plan → requête native. */
	map(plan: LogicalPlan): NativeQuery;
	/** Écriture : Mutation Plan → requête native. */
	mapMutation(plan: MutationPlan): NativeQuery;
}
