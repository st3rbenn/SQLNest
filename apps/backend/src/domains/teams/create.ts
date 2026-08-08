/**
 * `createPersonalTeam` — crée la team « Personal » d'un user
 * (auto-signup ou fallback lazy).
 *
 * ─── Contrat ─────────────────────────────────────────────────────────
 * - Idempotent : si l'user a DÉJÀ une team en tant qu'owner (n'importe
 *   laquelle), retourne la plus ancienne au lieu d'en créer une
 *   nouvelle. Évite les doublons si :
 *     * le hook Better Auth `user.create.after` et un `/api/teams/me/
 *       default` fallback tentent de créer la team en parallèle,
 *     * ou si un run précédent du seed a réussi puis on relance.
 * - Slug : `generateTeamSlug()` = 6 hex uniformes. Retry jusqu'à 5x
 *   sur `unique_violation` (collision astronomiquement rare).
 * - Name : passé explicite par le caller — soit `user.name` (si non
 *   vide), soit « Personal ». La logique de fallback vit chez le
 *   caller, cette fonction reste pure.
 *
 * ─── Race window ─────────────────────────────────────────────────────
 * L'idempotence est basée sur `SELECT WHERE owner_id = ...` non
 * verrouillé — deux appels concurrents peuvent tous deux voir "libre"
 * et tenter l'INSERT. La contrainte unique `team_slug_unique` filtre
 * les collisions de slug, mais deux teams pour le même owner peuvent
 * co-exister (pas de contrainte unique `(owner_id, name)` — un user
 * peut avoir plusieurs teams V2). Solution V1 : le SELECT initial
 * dans la même TX suffit dans 99% des cas. Le 1% restant crée une
 * seconde team parasite ; on tolère jusqu'à ce que V2 apporte la
 * gestion multi-teams propre.
 */

import { schema as dbSchema } from "@sqlnest/db";
import { asc, eq } from "drizzle-orm";
import type { DbOrTx } from "./db";
import { generateTeamSlug } from "./slug";

export interface CreatePersonalTeamResult {
	readonly teamId: string;
	readonly slug: string;
	readonly name: string;
	/** `true` si créée maintenant, `false` si réutilisée (idempotence). */
	readonly wasCreated: boolean;
}

export async function createPersonalTeam(
	db: DbOrTx,
	userId: string,
	name: string
): Promise<CreatePersonalTeamResult> {
	// 1. Idempotence : l'user a-t-il déjà une team ?
	const existing = await db
		.select({
			id: dbSchema.team.id,
			slug: dbSchema.team.slug,
			name: dbSchema.team.name
		})
		.from(dbSchema.team)
		.where(eq(dbSchema.team.ownerId, userId))
		.orderBy(asc(dbSchema.team.createdAt))
		.limit(1);
	const first = existing[0];
	if (first) {
		return {
			teamId: first.id,
			slug: first.slug,
			name: first.name,
			wasCreated: false
		};
	}

	// 2. INSERT avec retry sur unique_violation de slug (astronomique
	//    mais non nul).
	const MAX_ATTEMPTS = 5;
	for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
		const slug = generateTeamSlug();
		try {
			const inserted = await db
				.insert(dbSchema.team)
				.values({ slug, name, ownerId: userId })
				.returning({
					id: dbSchema.team.id,
					slug: dbSchema.team.slug,
					name: dbSchema.team.name
				});
			const row = inserted[0];
			if (!row) {
				throw new Error("createPersonalTeam: INSERT team n'a rien renvoyé");
			}
			return {
				teamId: row.id,
				slug: row.slug,
				name: row.name,
				wasCreated: true
			};
		} catch (err) {
			const message =
				err instanceof Error && "code" in err ? String(err.code) : "";
			if (message === "23505" && attempt < MAX_ATTEMPTS - 1) {
				continue;
			}
			throw err;
		}
	}
	throw new Error(
		`createPersonalTeam: impossible de trouver un slug unique après ${MAX_ATTEMPTS} tentatives`
	);
}

/**
 * Helper — nom par défaut de la team perso auto-créée à la signup.
 *
 * ─── Décision UX ─────────────────────────────────────────────────────
 * Retourne `<shortName>'s team` (pattern Notion : « zhack37's team »).
 * Différencie visuellement le user (« anthonincolas ») et la team
 * (« anthonincolas's team ») dans la sidebar sans redondance nominative.
 *
 * ─── Normalisation ───────────────────────────────────────────────────
 * Certains user ont `user.name` = leur email complet (Better Auth
 * fallback quand `name` n'est pas fourni au signup). On prend la
 * partie avant `@` pour éviter « anthonincolas@gmail.com's team ».
 * Fallback « My team » si vide.
 */
export function defaultTeamNameForUser(
	userName: string | null | undefined
): string {
	const raw = (userName ?? "").trim();
	if (raw.length === 0) return "My team";
	const atIdx = raw.indexOf("@");
	const short = atIdx > 0 ? raw.slice(0, atIdx) : raw;
	return `${short}'s team`;
}
