/**
 * Slug d'une team : 6 hex chars opaques, non-devinables.
 *
 * ─── Décision ────────────────────────────────────────────────────────
 * 6 hex = 24 bits d'entropie ≈ 16.7M combos. Suffisant pour un V1
 * (ownership 1 team = 1 user, pas de rename, invitations différées) :
 * la seule surface exploitable serait un attaquant qui devine le slug
 * d'une team d'un autre user, sans être invité. En V1 les routes
 * team-scoped 404 si owner_id ≠ request.user.id → deviner le slug ne
 * donne accès à rien.
 *
 * ─── Regex ──────────────────────────────────────────────────────────
 * `[0-9a-f]{6}` — enforcée côté Zod pour les params `/team/:slug`.
 * Pas de CHECK Postgres (overkill V1, le générateur ci-dessous est la
 * seule source de slugs légitimes).
 *
 * ─── Collision ──────────────────────────────────────────────────────
 * `crypto.randomBytes(3).toString('hex')` = uniforme dans 16.7M. Le
 * caller retry sur `unique_violation` — le seed SQL fait pareil côté
 * plpgsql.
 */

import { randomBytes } from "node:crypto";

export const TEAM_SLUG_REGEX = /^[0-9a-f]{6}$/;

export function generateTeamSlug(): string {
	return randomBytes(3).toString("hex");
}
