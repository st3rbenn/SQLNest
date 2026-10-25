/** ORM dont SQLNest écrit les migrations (ADR-035). */
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
