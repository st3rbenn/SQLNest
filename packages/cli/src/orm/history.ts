/**
 * Table où chaque ORM note les migrations appliquées (ADR-035 point 1) :
 * sa présence dit qu'une base est gérée par migrations, et par quel ORM.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { type DbEngine, ENGINE_LABELS } from "../services/connection-strings";
import type { OrmDetection } from "./detect";
import { ORM_LABELS, ORM_NAMES, type OrmName } from "./types";

export const HISTORY_TABLES: Readonly<Record<OrmName, string>> = {
	prisma: "_prisma_migrations",
	doctrine: "doctrine_migration_versions",
	sequelize: "SequelizeMeta",
	seaorm: "seaql_migrations"
};

/** Moteurs où un ORM ne tient pas d'historique de migrations : Prisma sous MongoDB (`db push`). */
const WITHOUT_HISTORY: Readonly<Partial<Record<OrmName, readonly string[]>>> = {
	prisma: ["mongodb"]
};

/** L'ORM tient un historique de migrations sous ce moteur (ADR-037 D3 bis). */
export function keepsHistory(orm: OrmName, engine: string): boolean {
	return !(WITHOUT_HISTORY[orm]?.includes(engine) ?? false);
}

/** Pourquoi aucune table d'historique n'est attendue. */
export function describeNoHistory(orm: OrmName, engine: string): string {
	const label = ENGINE_LABELS[engine as DbEngine] ?? engine;
	return `${ORM_LABELS[orm]} ne tient pas d'historique de migrations sous ${label} (db push) : SQLNest applique les changements lui-même`;
}

export interface HistoryCheck {
	/** Table de l'ORM du projet. */
	readonly table: string;
	readonly present: boolean;
	/** Table d'un autre ORM trouvée à sa place : la base est gérée par lui. */
	readonly other?: { readonly orm: OrmName; readonly table: string };
}

/** Tables de la base comparées à celle de l'ORM du projet (casse ignorée). */
export function checkHistory(
	orm: OrmName,
	tables: readonly string[]
): HistoryCheck {
	const names = new Set(tables.map((t) => t.toLowerCase()));
	const table = HISTORY_TABLES[orm];
	if (names.has(table.toLowerCase())) return { table, present: true };
	const other = ORM_NAMES.find(
		(o) => o !== orm && names.has(HISTORY_TABLES[o].toLowerCase())
	);
	return other !== undefined
		? {
				table,
				present: false,
				other: { orm: other, table: HISTORY_TABLES[other] }
			}
		: { table, present: false };
}

/** Le constat, en une phrase. */
export function describeHistory(orm: OrmName, check: HistoryCheck): string {
	if (check.present) return `${check.table} présente dans la base`;
	if (check.other !== undefined) {
		return `La base est gérée par ${ORM_LABELS[check.other.orm]} (${check.other.table}), pas par ${ORM_LABELS[orm]}`;
	}
	return `Aucune table ${check.table} : la base n'a encore reçu aucune migration ${ORM_LABELS[orm]}`;
}

/**
 * Dossier des migrations du projet, s'il existe : Prisma à côté du schéma,
 * Sequelize et Doctrine `migrations/`, SeaORM la crate `migration/`.
 */
export function migrationsDir(detection: OrmDetection): string | undefined {
	const candidates =
		detection.orm === "prisma"
			? [
					join(dirname(detection.configFile), "migrations"),
					join(detection.dir, "prisma", "migrations")
				]
			: detection.orm === "seaorm"
				? [join(detection.dir, "migration")]
				: [join(detection.dir, "migrations")];
	return candidates.find((dir) => existsSync(dir));
}
