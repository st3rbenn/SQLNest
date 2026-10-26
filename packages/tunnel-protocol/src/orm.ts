/**
 * ORM dont SQLNest écrit les migrations (ADR-035), partagés par le CLI et
 * l'app : nom, libellé, table où chacun note les migrations appliquées.
 */

export type OrmName = "prisma" | "doctrine" | "sequelize" | "seaorm";

export const ORM_NAMES: readonly OrmName[] = [
	"prisma",
	"doctrine",
	"sequelize",
	"seaorm"
];

/** Nom affiché d'un ORM. */
export const ORM_LABELS: Readonly<Record<OrmName, string>> = {
	prisma: "Prisma",
	doctrine: "Doctrine",
	sequelize: "Sequelize",
	seaorm: "SeaORM"
};

/**
 * Table d'historique de chaque ORM (ADR-035 point 1) : sa présence dit
 * qu'une base est gérée par migrations, et par quel ORM.
 */
export const ORM_HISTORY_TABLES: Readonly<Record<OrmName, string>> = {
	prisma: "_prisma_migrations",
	doctrine: "doctrine_migration_versions",
	sequelize: "SequelizeMeta",
	seaorm: "seaql_migrations"
};
