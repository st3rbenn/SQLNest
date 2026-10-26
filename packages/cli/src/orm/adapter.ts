/**
 * Mécanique d'un ORM (ADR-037 A4) : la boucle `applySchemaChange` est
 * commune, chaque ORM fournit ses étapes.
 */

import type { Connection } from "@sqlnest/engine";
import type {
	DDLPlan,
	DdlLowerOptions,
	NativeQuery,
	SchemaModel
} from "@sqlnest/snql";
import type {
	TunnelSchemaChangeNames,
	TunnelSchemaCheck
} from "@sqlnest/tunnel-protocol";
import type { LocalConnectionProject } from "../services/local-connections";
import type { OrmName } from "./types";

/** Un changement de schéma en cours, tel que l'adapter le reçoit. */
export interface SchemaChange {
	readonly project: LocalConnectionProject;
	readonly src: string;
	readonly plan: DDLPlan;
	/** DDL natif du changement, appliqué par SQLNest quand l'ORM ne tient pas d'historique. */
	readonly native: NativeQuery;
	/** SQL de la migration, SNQL d'origine en commentaire ; absent sans historique de migrations. */
	readonly sql?: string;
	/** Schéma de la base avant le changement. */
	readonly before: SchemaModel;
	readonly names?: TunnelSchemaChangeNames;
	/** Base de la connexion, sur laquelle l'outil de l'ORM agit. Jamais affichée. */
	readonly databaseUrl: string;
	readonly connection: Connection;
	readonly env: NodeJS.ProcessEnv;
}

/** Fichiers écrits par une étape (relatifs au projet), et leur annulation. */
export interface Written {
	readonly files: readonly string[];
	undo(): void;
}

export interface WrittenMigration extends Written {
	/** Nom de la migration : son dossier, ou son fichier. */
	readonly name: string;
}

export interface PatchedModel extends Written {
	/** Noms retenus, fournis ou déduits. */
	readonly names?: TunnelSchemaChangeNames;
}

export interface OrmAdapter {
	readonly orm: OrmName;
	/** Profil de DDL de l'ORM (ADR-036 D6), selon le moteur de la base. */
	ddlOptions(engine: string): DdlLowerOptions;
	/**
	 * `false` : l'ORM ne tient pas d'historique de migrations sous ce moteur
	 * (Prisma sous MongoDB, `db push`) — pas de fichier de migration, SQLNest
	 * applique le DDL lui-même (ADR-037 D3 bis).
	 */
	migrations(engine: string): boolean;
	/** Avant toute écriture : l'outil de l'ORM est là, la base est à jour de ses migrations. */
	preflight(change: SchemaChange): Promise<void>;
	writeMigration(change: SchemaChange): Promise<WrittenMigration>;
	patchModel(change: SchemaChange): Promise<PatchedModel>;
	/** Mise en forme et validation du modèle par l'outil de l'ORM, avant la base. */
	validate(change: SchemaChange): Promise<void>;
	apply(change: SchemaChange, migration: WrittenMigration): Promise<void>;
	/** Après l'échec d'`apply` : l'historique de l'ORM marque la migration annulée. */
	rollback(change: SchemaChange, migration: WrittenMigration): Promise<void>;
	/** Contrôles natifs de l'ORM ; `applied` : le changement est en base. */
	check(
		change: SchemaChange,
		migration: WrittenMigration | undefined,
		applied: boolean
	): Promise<TunnelSchemaCheck[]>;
}

/** Échec d'une étape de la boucle : le message part tel quel dans la réponse. */
export class SchemaChangeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SchemaChangeError";
	}
}
