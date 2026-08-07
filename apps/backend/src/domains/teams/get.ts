/**
 * Lookups team — helpers de lecture.
 */

import { schema as dbSchema } from "@sqlnest/db";
import { and, asc, eq } from "drizzle-orm";
import type { DbOrTx } from "./db";

export interface TeamSummary {
	readonly id: string;
	readonly slug: string;
	readonly name: string;
	readonly ownerId: string;
	readonly createdAt: Date;
}

/** Retrouve une team par slug. `null` si inconnu. */
export async function getTeamBySlug(
	db: DbOrTx,
	slug: string
): Promise<TeamSummary | null> {
	const rows = await db
		.select({
			id: dbSchema.team.id,
			slug: dbSchema.team.slug,
			name: dbSchema.team.name,
			ownerId: dbSchema.team.ownerId,
			createdAt: dbSchema.team.createdAt
		})
		.from(dbSchema.team)
		.where(eq(dbSchema.team.slug, slug))
		.limit(1);
	return rows[0] ?? null;
}

/** Toutes les teams d'un user (owner). V1 : 1 team, V2 : N. */
export async function listTeamsOfUser(
	db: DbOrTx,
	userId: string
): Promise<TeamSummary[]> {
	return db
		.select({
			id: dbSchema.team.id,
			slug: dbSchema.team.slug,
			name: dbSchema.team.name,
			ownerId: dbSchema.team.ownerId,
			createdAt: dbSchema.team.createdAt
		})
		.from(dbSchema.team)
		.where(eq(dbSchema.team.ownerId, userId))
		.orderBy(asc(dbSchema.team.createdAt));
}

/** La team par défaut d'un user = la plus ancienne. Utilisé pour le
 *  redirect `/` → `/team/:defaultSlug`. `null` si l'user n'a pas de
 *  team (cas géré via le fallback lazy dans la route
 *  `/api/teams/me/default`). */
export async function getDefaultTeamOfUser(
	db: DbOrTx,
	userId: string
): Promise<TeamSummary | null> {
	const rows = await db
		.select({
			id: dbSchema.team.id,
			slug: dbSchema.team.slug,
			name: dbSchema.team.name,
			ownerId: dbSchema.team.ownerId,
			createdAt: dbSchema.team.createdAt
		})
		.from(dbSchema.team)
		.where(eq(dbSchema.team.ownerId, userId))
		.orderBy(asc(dbSchema.team.createdAt))
		.limit(1);
	return rows[0] ?? null;
}

/** Vérifie qu'une team appartient bien à l'user. `null` si absente
 *  OU si l'owner diffère — on ne distingue pas 404 / 403 pour éviter
 *  la fuite d'existence. */
export async function getTeamForOwner(
	db: DbOrTx,
	slug: string,
	userId: string
): Promise<TeamSummary | null> {
	const rows = await db
		.select({
			id: dbSchema.team.id,
			slug: dbSchema.team.slug,
			name: dbSchema.team.name,
			ownerId: dbSchema.team.ownerId,
			createdAt: dbSchema.team.createdAt
		})
		.from(dbSchema.team)
		.where(and(eq(dbSchema.team.slug, slug), eq(dbSchema.team.ownerId, userId)))
		.limit(1);
	return rows[0] ?? null;
}
