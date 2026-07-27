import type { LogicalPlan } from "../ir/plan";

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

/** Requête native produite pour un moteur donné. */
export type NativeQuery = SqlQuery | MongoQuery;

/** Contrat de codegen par moteur : Logical Plan → requête native. Pur, sans I/O. */
export interface Mapper {
	readonly engine: string;
	map(plan: LogicalPlan): NativeQuery;
}
